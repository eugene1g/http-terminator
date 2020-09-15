// @flow

/* eslint-disable ava/no-ignored-test-files */

import test from 'ava';
import sinon from 'sinon';
import delay from 'delay';
import got from 'got';
import KeepAliveHttpAgent from 'agentkeepalive';
import createHttpTerminator from '../../src/factories/createHttpTerminator';
import type {
  HttpServerFactoryType,
} from './createHttpServer';
import type {
  HttpsServerFactoryType,
} from './createHttpsServer';

const KeepAliveHttpsAgent = KeepAliveHttpAgent.HttpsAgent;

export default (createHttpServer: HttpServerFactoryType | HttpsServerFactoryType) => {
  test('terminates HTTP server with no connections', async (t) => {
    const httpServer = await createHttpServer(() => {});

    // eslint-disable-next-line ava/use-t-well
    t.timeout(100);

    t.true(httpServer.server.listening);

    const terminator = createHttpTerminator({
      server: httpServer.server,
    });

    await terminator.terminate();

    t.false(httpServer.server.listening);
  });

  test('terminates hanging sockets after gracefulTerminationTimeout', async (t) => {
    const spy = sinon.spy();

    const httpServer = await createHttpServer(() => {
      spy();
    });

    // eslint-disable-next-line ava/use-t-well
    t.timeout(500);

    const terminator = createHttpTerminator({
      gracefulTerminationTimeout: 150,
      server: httpServer.server,
    });

    got(httpServer.url);

    await delay(50);

    t.true(spy.called);

    terminator.terminate();

    await delay(100);

    // The timeout has not passed.
    t.is(await httpServer.getConnections(), 1);

    await delay(100);

    t.is(await httpServer.getConnections(), 0);
  });

  test('server stops accepting new connections after terminator.terminate() is called', async (t) => {
    const stub = sinon.stub();

    stub
      .onCall(0)
      .callsFake((incomingMessage, outgoingMessage) => {
        setTimeout(() => {
          outgoingMessage.end('foo');
        }, 100);
      });

    stub
      .onCall(1)
      .callsFake((incomingMessage, outgoingMessage) => {
        outgoingMessage.end('bar');
      });

    const httpServer = await createHttpServer(stub);

    // eslint-disable-next-line ava/use-t-well
    t.timeout(500);

    const terminator = createHttpTerminator({
      gracefulTerminationTimeout: 150,
      server: httpServer.server,
    });

    const request0 = got(httpServer.url);

    await delay(50);

    terminator.terminate();

    await delay(50);

    const request1 = got(httpServer.url, {
      retry: 0,
      timeout: {
        connect: 50,
      },
    });

    // @todo https://stackoverflow.com/q/59832897/368691
    await t.throwsAsync(request1);

    const response0 = await request0;

    t.is(response0.headers.connection, 'close');
    t.is(response0.body, 'foo');
  });

  // test('ongoing requests receive {connection: close} header', async (t) => {
  //   const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
  //     setTimeout(() => {
  //       outgoingMessage.end('foo');
  //     }, 100);
  //   });
  //
  //   // eslint-disable-next-line ava/use-t-well
  //   t.timeout(600);
  //
  //   const terminator = createHttpTerminator({
  //     gracefulTerminationTimeout: 150,
  //     server: httpServer.server,
  //   });
  //
  //   const httpAgent = new KeepAliveHttpAgent({
  //     maxSockets: 1,
  //   });
  //
  //   const httpsAgent = new KeepAliveHttpsAgent({
  //     maxSockets: 1,
  //   });
  //
  //   const request = got(httpServer.url, {
  //     agent: {
  //       http: httpAgent,
  //       https: httpsAgent,
  //     },
  //   });
  //
  //   await delay(50);
  //
  //   terminator.terminate();
  //
  //   const response = await request;
  //
  //   t.is(response.headers.connection, 'close');
  //   t.is(response.body, 'foo');
  // });

  test('ongoing requests receive {connection: close} header (new request reusing an existing socket)', async (t) => {
    const stub = sinon.stub();

    stub
      .onCall(0)
      .callsFake((incomingMessage, outgoingMessage) => {
        outgoingMessage.write('foo');

        setTimeout(() => {
          outgoingMessage.end('bar');
        }, 50);
      });

    stub
      .onCall(1)
      .callsFake((incomingMessage, outgoingMessage) => {
        // @todo Unable to intercept the response without the delay.
        // When `end()` is called immediately, the `request` event
        // already has `headersSent=true`. It is unclear how to intercept
        // the response beforehand.
        setTimeout(() => {
          outgoingMessage.end('baz');
        }, 50);
      });

    const httpServer = await createHttpServer(stub);

    // eslint-disable-next-line ava/use-t-well
    t.timeout(1000);

    const terminator = createHttpTerminator({
      gracefulTerminationTimeout: 150,
      server: httpServer.server,
    });

    const httpAgent = new KeepAliveHttpAgent({
      maxSockets: 1,
    });

    const httpsAgent = new KeepAliveHttpsAgent({
      maxSockets: 1,
    });

    const request0 = got(httpServer.url, {
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
    });

    await delay(50);

    terminator.terminate();

    const request1 = got(httpServer.url, {
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
      retry: 0,
    });

    await delay(50);

    t.is(stub.callCount, 2);

    const response0 = await request0;

    t.is(response0.headers.connection, 'keep-alive');
    t.is(response0.body, 'foobar');

    const response1 = await request1;

    t.is(response1.headers.connection, 'close');
    t.is(response1.body, 'baz');
  });

  test('does not send {connection: close} when server is not terminating', async (t) => {
    const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
      setTimeout(() => {
        outgoingMessage.end('foo');
      }, 50);
    });

    // eslint-disable-next-line ava/use-t-well
    t.timeout(100);

    createHttpTerminator({
      server: httpServer.server,
    });

    const httpAgent = new KeepAliveHttpAgent({
      maxSockets: 1,
    });

    const httpsAgent = new KeepAliveHttpsAgent({
      maxSockets: 1,
    });

    const response = await got(httpServer.url, {
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
    });

    t.is(response.headers.connection, 'keep-alive');
  });

  test('terminates at gracefulTerminationTimeout if sockets do not close in time', async (t) => {
    const spy = sinon.spy();

    const httpServer = await createHttpServer(() => {
      spy();
    });

    // eslint-disable-next-line ava/use-t-well
    t.timeout(1000);

    const terminator = createHttpTerminator({
      gracefulTerminationTimeout: 500,
      server: httpServer.server,
    });

    got(httpServer.url);

    await delay(50);

    t.true(spy.called);
    t.is(await httpServer.getConnections(), 1);

    await terminator.terminate();
    t.is(await httpServer.getConnections(), 0);
  });

  test('terminates as soon as all sockets close by themselves', async (t) => {
    const spy = sinon.spy();

    const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
      setTimeout(() => {
        spy();
        outgoingMessage.end('foo');
      }, 500);
    });

    // eslint-disable-next-line ava/use-t-well
    t.timeout(750);

    const terminator = createHttpTerminator({
      gracefulTerminationTimeout: 1000,
      server: httpServer.server,
    });

    got(httpServer.url);

    await delay(50);

    t.false(spy.called);
    t.is(await httpServer.getConnections(), 1);
    await delay(600);
    t.true(spy.called);
    t.is(await httpServer.getConnections(), 0);
    await terminator.terminate();
  });
};
