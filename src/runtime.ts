import {Block} from './block.js';
import Costume, {CostumeParams} from './costume.js';
import {GreenFlagEvent, KeyPressedEvent} from './events.js';
import IO from './io.js';
import Interpreter from './interpreter/interpreter.js';
import {Loader, WebLoader, ZipLoader, ZipSrc} from './loader.js';
import parseProject from './parser.js';
import Project from './project.js';
import Renderer from './renderer/renderer.js';
import Sound from './sound.js';
import Target from './target.js';
import {TypedEvent} from './typed-events.js';
import Thread from './interpreter/thread.js';
import Rectangle from './renderer/rectangle.js';
import {InternalStageElement} from './html/stage.js';

/** Time between each interpreter step (aka framerate). */
const STEP_TIME = 1000 / 30;

export default class Runtime {
    public stepTime: number = STEP_TIME;
    public stageBounds = Rectangle.fromBounds(-240, 240, -180, 180);

    private audioContext: AudioContext;
    private project: Project | null = null;
    private interpreter: Interpreter;
    private renderer: Renderer | null = null;
    private io: IO;

    private steppingInterval: NodeJS.Timeout | null = null;

    private unregisterPreviousProject: (() => void) | null = null;
    private unsetPreviousStage: (() => void) | null = null;

    constructor() {
        this.audioContext = new AudioContext();
        this.io = new IO();
        this.interpreter = new Interpreter(this.stepTime, {
            io: this.io,
            stageBounds: this.stageBounds,
        });
    }

    public async loadProjectFromLoader(loader: Loader): Promise<Project> {
        const manifest = await loader.loadProjectManifest();
        return parseProject(manifest, loader, this);
    }

    public async loadProjectFromID(id: string): Promise<Project> {
        const loader = new WebLoader(id);
        return this.loadProjectFromLoader(loader);
    }

    public async loadProjectFromZip(zip: ZipSrc): Promise<Project> {
        const loader = new ZipLoader(zip);
        return this.loadProjectFromLoader(loader);
    }

    public setProject(project: Project | null) {
        if (this.unregisterPreviousProject) {
            this.unregisterPreviousProject();
            this.unregisterPreviousProject = null;
        }

        this.project = project;
        if (!project) return;

        this.interpreter.setProject(project);

        const unregisterProject = project.register();
        this.unregisterPreviousProject = () => {
            this.project = null;
            this.stop();
            unregisterProject();
            this.interpreter.setProject(null);
        };
    }

    public attachStage(stage: InternalStageElement | null) {
        if (this.unsetPreviousStage) {
            this.unsetPreviousStage();
            this.unsetPreviousStage = null;
        }

        if (!stage) return;

        const renderer = this.renderer = new Renderer(stage.canvas, this.stageBounds);
        // Allow stage to receive keyboard events
        stage.tabIndex = 0;
        const teardownEventListeners = this.setupEventListeners(stage);

        this.unsetPreviousStage = () => {
            this.renderer = null;
            renderer.destroy();
            teardownEventListeners();
        };
    }

    private setupEventListeners(stage: InternalStageElement) {
        if (!this.renderer) return () => {};
        const abortController = new AbortController();
        const signal = abortController.signal;

        const stageCoordsFromPointerEvent = (event: PointerEvent): {x: number; y: number} => {
            const rect = stage.getBoundingClientRect();
            let x = (event.clientX - rect.left) * (this.stageBounds.width / rect.width);
            let y = (event.clientY - rect.top) * (this.stageBounds.height / rect.height);
            x = Math.max(
                this.stageBounds.left,
                Math.min(
                    this.stageBounds.right,
                    Math.round(x + this.stageBounds.left)));
            y = Math.max(
                this.stageBounds.bottom,
                Math.min(
                    this.stageBounds.top,
                    Math.round(y + this.stageBounds.bottom)));

            return {x, y: -y};
        };

        window.addEventListener('pointermove', event => {
            const {x, y} = stageCoordsFromPointerEvent(event);
            this.io.mousePosition.x = x;
            this.io.mousePosition.y = y;
        }, {signal});

        stage.addEventListener('pointerdown', () => {
            this.io.mouseDown = true;
            if (!this.project || !this.renderer) return;
            const {x, y} = this.io.mousePosition;
            // "when this sprite / stage clicked" hats fire when the mouse is pressed, not when it's released.
            // If no target is clicked, always count the stage as being clicked even if it's transparent where the
            // cursor is.
            const clickedTarget = this.renderer.pick(this.project.targets, x, y) ?? this.project.stage;
            clickedTarget?.click();
        }, {signal});

        window.addEventListener('pointerup', () => {
            this.io.mouseDown = false;
        }, {signal});

        stage.addEventListener('keydown', event => {
            const key = IO.domToScratchKey(event.key);
            if (key === null) return;

            event.preventDefault();
            this.io.keysDown.add(key);
            this.interpreter.startHats('keypressed', new KeyPressedEvent(key));
        }, {signal});

        window.addEventListener('keyup', event => {
            const key = IO.domToScratchKey(event.key);
            if (key === null) return;

            this.io.keysDown.delete(key);
        }, {signal});

        return () => {
            abortController.abort();
        };
    }

    public destroy() {
        this.setProject(null);
    }

    public start() {
        if (this.steppingInterval) return;
        this.steppingInterval = setInterval(this.step.bind(this), this.stepTime);
    }

    public stop() {
        if (!this.steppingInterval) return;
        clearInterval(this.steppingInterval);
        this.steppingInterval = null;
    }

    public async loadSound(name: string, src: Blob): Promise<Sound> {
        const buffer = await src.arrayBuffer();
        let audioBuffer = null;
        try {
            audioBuffer = await this.audioContext.decodeAudioData(buffer);
        } catch (err) {
            // TODO: decode ADPCM
        }
        return new Sound(name, audioBuffer, this.audioContext);
    }

    public async loadCostume(name: string, src: Blob, params: CostumeParams): Promise<Costume> {
        return Costume.load(name, src, params);
    }

    public requestRedraw() {
        this.interpreter.requestRedraw();
    }

    public launchScript(
        script: Block[],
        target: Target,
        event: TypedEvent | null,
        restartExistingThreads: boolean,
    ) {
        return this.interpreter.launch(script, target, event, restartExistingThreads);
    }

    public greenFlag() {
        this.stopAll();
        this.interpreter.startHats('greenflag', new GreenFlagEvent());
    }

    public stopAll() {
        this.interpreter.stopAll();
        this.project?.stopAll();
    }

    public stopTargetThreads(target: Target, exceptFor?: Thread) {
        this.interpreter.stopTargetThreads(target, exceptFor);
    }

    private step() {
        if (!this.project) {
            throw new Error('Cannot step without a project');
        }
        this.interpreter.stepThreads();
        this.renderer?.draw(this.project.targets);
    }
}
