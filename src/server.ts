import http from 'http';
import express from 'express';
import bodyParser from 'body-parser';
import './config/logging';
import { server } from './config/config';
import upload from 'express-fileupload';
import routes from './routes';
import path from 'path';
import { corsHandler } from './helpers/corsHandler';
import { createData } from './helpers/api';
export const app = express();
export const application = app;
export let httpServer: ReturnType<typeof http.createServer>;

app.use(upload());
app.use(bodyParser.urlencoded({ extended: false, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));

export let secrets = {
    BASE_URL: 'https://documents-225250995708.europe-west1.run.app/api',
    DEEP_SEEK_API: 'sk-aee53cdb70a04ea7baa613ddc897ade0'
};

export const Main = () => {
    app.use(express.urlencoded({ extended: true }));
    const filesPath = path.join(__dirname, '..', 'files');
    app.use('/api', express.static(filesPath));

    app.use(corsHandler);

    app.use(express.json({ limit: '10mb' }));
    app.use('/api', routes);

    httpServer = http.createServer(app);

    httpServer.listen(server.SERVER_PORT, async () => {
        console.log(`Server started on ${server.SERVER_HOSTNAME}:${server.SERVER_PORT}`);
    });
};

export const Shutdown = (callback: any) => httpServer && httpServer.close(callback);
/**ZARAI2026.01.24N	25/01/2026	31/01/2026	11
ZARAI2026.01.24S	31/Jan/2026	08/Feb/2026	11
ZAADD2026.02.15N	16/Feb/2026	22/Feb/2026	11
ZAADD2026.02.15N	22/Feb/2026	02/03/2026	11 */

const tours = [
    { tourId: '1', tour_name: 'RAINBOW', tour_reference: 'ZARAI2026.01.24N', startDate: '2026-01-25', endDate: '2026-01-31', status: 'planned', pax: 11 },
    { tourId: '2', tour_name: 'RAINBOW', tour_reference: 'ZARAI2026.01.24S', startDate: '2026-02-16', endDate: '2026-02-22', status: 'planned', pax: 11 },
    { tourId: '3', tour_name: 'AADO', tour_reference: 'ZAADD2026.02.15N', startDate: '2026-02-22', endDate: '2026-02-28', status: 'planned', pax: 11 },
    { tourId: '4', tour_name: 'AADO', tour_reference: 'ZAADD2026.02.15N', startDate: '2026-02-22', endDate: '2026-02-28', status: 'planned', pax: 11 },
];

export const addTours = async () => {
    for (const tour of tours) {
        await createData('tours', tour.tourId, { ...tour, created_at: new Date(), updated_at: new Date(), supplier: 'Fairfield Tours - Bookings 2078', organisationId: 'org1' });
        console.log(`Tour ${tour.tourId} added`);
    }
};
export const addUsers = async () => {
    const users = [
        { username: 'ops1', pin: '3333', role: 'ops', organisationId: 'org1', uid: 'ops1', name: 'Ops User' },
        { username: 'owner1', pin: '4444', role: 'owner', organisationId: 'org1', uid: 'owner1', name: 'Owner User' },
        { username: 'tor1', pin: '1111', role: 'tour_manager', organisationId: 'org1', uid: 'tor1', name: 'Lameck Ndhlovu' }
    ];

    for (const user of users) {
        await createData('users', user.username, user);
    }
};

Main();
