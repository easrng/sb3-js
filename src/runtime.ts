import {Block} from './block.js';
import Costume, {CostumeParams} from './costume.js';
import {GreenFlagEvent, KeyPressedEvent} from './events.js';
import IO from './io.js';
import Interpreter from './interpreter/interpreter.js';
import {Loader, WebLoader, ZipLoader, ZipSrc} from './loader.js';
import parseProject from './parser.js';
import Project, {CreateMonitorEvent} from './project.js';
import Renderer from './renderer/renderer.js';
import Sound from './sound.js';
import Target from './target.js';
import {TypedEvent} from './typed-events.js';
import Thread from './interpreter/thread.js';
import Rectangle from './rectangle.js';
import {InternalStageElement} from './html/stage.js';
import {Theme, defaultTheme} from './theme.js';
import {Monitor, MonitorView} from './monitor.js';

/** Time between each interpreter step (aka framerate). */
const STEP_TIME = 1000 / 30;

export type RuntimeSettings = {
    theme?: Theme;
    username?: string;
};

export default class Runtime {
    public stepTime: number = STEP_TIME;
    public stageBounds = Rectangle.fromBounds(-240, 240, -180, 180);

    private audioContext: AudioContext;
    private project: Project | null = null;
    private interpreter: Interpreter;
    private renderer: Renderer | null = null;
    private io: IO;
    private stage: InternalStageElement | null = null;
    private theme: Theme;
    private monitorViews: Map<Monitor, {view: MonitorView; abort: AbortController}> = new Map();

    private steppingInterval: NodeJS.Timeout | null = null;

    private unregisterPreviousProject: (() => void) | null = null;
    private unsetPreviousStage: (() => void) | null = null;

    constructor(settings?: RuntimeSettings) {
        this.audioContext = new AudioContext();
        this.io = new IO();
        this.interpreter = new Interpreter(this.stepTime, {
            io: this.io,
            stageBounds: this.stageBounds,
            renderer: null,
        });
        this.theme = settings?.theme ?? defaultTheme;
        this.io.username = settings?.username ?? '';
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

        const controller = new AbortController();
        project.addEventListener(
            'createmonitor',
            this.handleMonitorCreated.bind(this, controller.signal),
            {signal: controller.signal},
        );
        for (const {monitor} of project.monitors) {
            this.handleMonitorCreated(controller.signal, new CreateMonitorEvent(monitor));
        }

        const unregisterProject = project.register();
        this.unregisterPreviousProject = () => {
            this.project = null;
            this.stop();
            for (const {monitor} of project.monitors) {
                this.removeMonitorView(monitor);
            }
            this.penLayer?.clear();
            unregisterProject();
            controller.abort();
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
        this.interpreter.setRenderer(renderer);
        // Allow stage to receive keyboard events
        stage.tabIndex = 0;
        const teardownEventListeners = this.setupEventListeners(stage);
        this.stage = stage;

        this.unsetPreviousStage = () => {
            this.renderer = null;
            this.interpreter.setRenderer(null);
            this.stage = null;
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
        // Step once immediately
        this.step();
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

    public get penLayer() {
        return this.renderer?.penLayer;
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
        // Step monitors after threads to capture the latest values
        this.stepMonitors();
        this.renderer?.draw(this.project.targets);
    }

    private stepMonitors() {
        if (!this.project) return;
        const {monitors, stage} = this.project;
        if (!stage) throw new Error('Project has no stage');

        for (const {monitor, updateMonitorBlock} of monitors) {
            if (!monitor.visible) continue;
            this.interpreter.launch([updateMonitorBlock], monitor.target ?? stage, null, true);
        }
    }

    private handleMonitorUpdated(monitor: Monitor) {
        if (!this.project || !this.stage) return;

        if (!monitor.visible) {
            this.removeMonitorView(monitor);
            return;
        }

        // Fetch or create the view for this monitor
        let viewAndAbortController = this.monitorViews.get(monitor);
        if (!viewAndAbortController) {
            const view = this.stage.createMonitorView() as MonitorView;
            const abort = new AbortController();
            viewAndAbortController = {
                view,
                abort,
            };
            this.monitorViews.set(monitor, viewAndAbortController);
            view.addEventListener('sliderchange', event => {
                const sliderHandler = monitor.block.proto.monitorSliderHandler;
                if (!sliderHandler) return;
                const target = monitor.target ?? this.project?.stage;
                if (!target) {
                    throw new Error('Project not set');
                }
                sliderHandler(monitor.block.inputValues, target, event.value);
            }, {signal: abort.signal});
        }

        const {view} = viewAndAbortController;
        view.update(monitor);

        // First time showing this monitor and there's no position yet. We need to render the monitor once to get
        // its size, then once more to position it.
        if (!monitor.position) {
            const monitorRects = [];
            for (const {monitor: otherMonitor} of this.project.monitors) {
                if (otherMonitor === monitor) continue;
                const viewAndAbortController = this.monitorViews.get(otherMonitor);
                if (!viewAndAbortController) continue;
                const bounds = viewAndAbortController.view.getBounds();
                if (bounds) monitorRects.push(bounds);
            }
            monitor.update({position: view.layout(monitorRects)});
            view.update(monitor);
        }

        const colorCategory = monitor.block.proto.colorCategory;
        if (colorCategory) view.setColor(this.theme.text, this.theme.blocks[colorCategory].primary);
    }

    private handleMonitorCreated(signal: AbortSignal, event: CreateMonitorEvent) {
        if (!this.stage) return;
        const {monitor} = event;
        monitor.addEventListener('updatemonitor', this.handleMonitorUpdated.bind(this, monitor), {signal});
    }

    private removeMonitorView(monitor: Monitor) {
        const viewAndAbortController = this.monitorViews.get(monitor);
        if (viewAndAbortController) {
            viewAndAbortController.view.remove();
            viewAndAbortController.abort.abort();
            this.monitorViews.delete(monitor);
        }
    }
}
