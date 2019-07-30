import * as Koa from 'koa';
import * as bodyParser from 'koa-bodyparser';
import * as koaCompress from 'koa-compress';
import * as route from 'koa-route';
import * as koaSend from 'koa-send';
import * as koaLogger from 'koa-logger';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as url from 'url';

import {Renderer} from './renderer';
import {Config, ConfigManager} from './config';

/**
 * Rendertron rendering service. This runs the server which routes rendering
 * requests through to the renderer.
 */
export class Rendertron {
    app: Koa = new Koa();
    private config: Config = ConfigManager.config;
    private renderer: Renderer | undefined;
    private port = process.env.PORT;

    async initialize() {
        // Load config
        this.config = await ConfigManager.getConfiguration();

        this.port = this.port || this.config.port;


        const browser = await puppeteer.launch({args: ['--no-sandbox']});
        this.renderer = new Renderer(browser, this.config);

        this.app.use(koaLogger());

        this.app.use(koaCompress());

        this.app.use(bodyParser());

        this.app.use(route.get('/', async (ctx: Koa.Context) => {
            await koaSend(
                ctx, 'index.html', {root: path.resolve(__dirname, '../src')});
        }));
        this.app.use(
            route.get('/_ah/health', (ctx: Koa.Context) => ctx.body = 'OK'));

        // Optionally enable cache for rendering requests.
        if (this.config.datastoreCache) {
            const {DatastoreCache} = await import('./datastore-cache');
            this.app.use(new DatastoreCache().middleware());
        }

        this.app.use(route.get('/render/:url(.*)', this.handleRenderRequest.bind(this)));
        this.app.use(route.get('/renderJson/:url(.*)', this.handleRenderJsonRequest.bind(this)));

        return this.app.listen(this.port, () => {
            console.log(`Listening on port ${this.port}`);
        });
    }

    /**
     * Checks whether or not the URL is valid. For example, we don't want to allow
     * the requester to read the file system via Chrome.
     */
    static restricted(href: string): boolean {
        const parsedUrl = url.parse(href);
        const protocol = parsedUrl.protocol || '';

        return !protocol.match(/^https?/);
    }

    async handleRenderRequest(ctx: Koa.Context, url: string) {
        if (!this.renderer) {
            throw (new Error('No renderer initalized yet.'));
        }

        if (Rendertron.restricted(url)) {
            ctx.status = 403;
            return;
        }

        const mobileVersion = 'mobile' in ctx.query;

        const serialized = await this.renderer.serialize(url, mobileVersion);
        // Mark the response as coming from Rendertron.
        ctx.set('x-renderer', 'rendertron');
        ctx.status = serialized.status;
        ctx.body = serialized.content;
    }

    async handleRenderJsonRequest(ctx: Koa.Context, url: string) {
        if (!this.renderer) {
            throw (new Error('No renderer initalized yet.'));
        }

        if (Rendertron.restricted(url)) {
            ctx.status = 403;
            return;
        }

        const mobileVersion = 'mobile' in ctx.query;
        const serialized = await this.renderer.serializeFx(url, mobileVersion);

        ctx.set('Content-Type', 'application/json');
        ctx.body = JSON.stringify(serialized);
    }

}

async function logUncaughtError(error: Error) {
    console.error('Uncaught exception');
    console.error(error);
    process.exit(1);
}

// Start rendertron if not running inside tests.
if (!module.parent) {
    const rendertron = new Rendertron();
    rendertron.initialize();

    process.on('uncaughtException', logUncaughtError);
    process.on('unhandledRejection', logUncaughtError);
}
