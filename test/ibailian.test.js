/**
 * i百联 Surge 专用模块与脚本的静态检查 + vm 沙箱端到端测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
    sgmodule: path.join(ROOT, 'ibailian', 'ibailian_signin.sgmodule'),
    gettoken: path.join(ROOT, 'ibailian', 'ibailian_gettoken.js'),
    signin: path.join(ROOT, 'ibailian', 'ibailian_signin.js'),
    readme: path.join(ROOT, 'ibailian', 'README.md')
};

function readFile(key) {
    return fs.readFileSync(FILES[key], 'utf8');
}

function runGetToken(options = {}) {
    const {
        store = {},
        headers = {},
        argument,
        writeOk = true,
        timeoutMs = 2000
    } = options;

    const notifications = [];
    const logs = [];
    let doneCount = 0;
    let donePayload;

    const sandbox = {
        console: { log: (...args) => logs.push(args.join(' ')) },
        Date,
        JSON,
        Number,
        String,
        Object,
        Array,
        Error,
        RegExp,
        Math,
        parseInt,
        encodeURIComponent,
        decodeURIComponent,
        $environment: { 'surge-version': '5.0.0', system: 'iOS' },
        $request: { headers },
        $persistentStore: {
            read: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            write: (v, k) => {
                if (!writeOk) return false;
                store[k] = v;
                return true;
            }
        },
        $notification: {
            post: (title, subtitle, body) => notifications.push({ title, subtitle, body })
        }
    };
    if (argument !== undefined) sandbox.$argument = argument;
    sandbox.global = sandbox;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`ibailian_gettoken.js did not call $done() within ${timeoutMs}ms`)),
            timeoutMs
        );

        sandbox.$done = (payload) => {
            doneCount++;
            donePayload = payload;
            if (doneCount === 1) {
                clearTimeout(timer);
                setTimeout(() => resolve({ store, notifications, logs, doneCount, donePayload }), 0);
            }
        };

        vm.createContext(sandbox);
        try {
            vm.runInContext(readFile('gettoken'), sandbox, { timeout: timeoutMs });
        } catch (err) {
            clearTimeout(timer);
            reject(err);
        }
    });
}

function runSignIn(options = {}) {
    const {
        store = {},
        argument,
        input,
        trigger,
        postHandler,
        timeoutMs = 3000
    } = options;

    const notifications = [];
    const logs = [];
    const requests = [];
    let doneCount = 0;
    let donePayload;

    const sandbox = {
        console: { log: (...args) => logs.push(args.join(' ')) },
        setTimeout,
        clearTimeout,
        Date,
        JSON,
        Number,
        String,
        Object,
        Array,
        Boolean,
        Error,
        RegExp,
        Math,
        parseInt,
        encodeURIComponent,
        decodeURIComponent,
        // 故意不注入 atob / btoa / $base64，以贴近 Surge JSC 运行环境
        $environment: { 'surge-version': '5.0.0', system: 'iOS' },
        $persistentStore: {
            read: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            write: (v, k) => {
                store[k] = v;
                return true;
            }
        },
        $notification: {
            post: (title, subtitle, body) => notifications.push({ title, subtitle, body })
        },
        $httpClient: {
            post: (opts, cb) => {
                requests.push(opts);
                if (!postHandler) {
                    cb('unexpected http call', null, '');
                    return;
                }
                setTimeout(() => postHandler(opts, cb), 0);
            }
        }
    };
    if (argument !== undefined) sandbox.$argument = argument;
    if (input !== undefined) sandbox.$input = input;
    if (trigger !== undefined) sandbox.$trigger = trigger;
    sandbox.global = sandbox;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`ibailian_signin.js did not call $done() within ${timeoutMs}ms`)),
            timeoutMs
        );

        sandbox.$done = (payload) => {
            doneCount++;
            donePayload = payload;
            if (doneCount === 1) {
                clearTimeout(timer);
                setTimeout(() => resolve({ store, notifications, logs, requests, doneCount, donePayload }), 0);
            }
        };

        vm.createContext(sandbox);
        try {
            vm.runInContext(readFile('signin'), sandbox, { timeout: timeoutMs });
        } catch (err) {
            clearTimeout(timer);
            reject(err);
        }
    });
}

function encodeBase64WithPadding(obj, targetPadCount) {
    const data = { ...obj };
    let b64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    let pad = '';
    while (
        (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) !== targetPadCount
    ) {
        pad += ' ';
        data._pad = pad;
        b64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    }
    return b64;
}

// ============= 1. 模块与脚本静态检查 =============

test('ibailian 模块元数据、MITM 与 Panel 语法符合 Surge 规范', () => {
    const sgmodule = readFile('sgmodule');

    assert.match(sgmodule, /^#!name=i百联每日签到/m);
    assert.match(sgmodule, /^#!system=ios$/m);
    assert.match(sgmodule, /^#!arguments=cron:0 9 \* \* \*,account_count:1,capture_slot:1,notify_mode:all$/m);
    assert.match(sgmodule, /^#!arguments-desc=.+/m);
    assert.match(sgmodule, /\[MITM\][\s\S]*hostname\s*=\s*%APPEND%\s*mh5\.bl\.com/);

    // [Script] 使用 Surge 语法
    assert.match(
        sgmodule,
        /^ibailian_gettoken\s*=\s*type=http-request,\s*pattern=\^https\?:\\\/\\\/mh5\\\.bl\\\.com\\\/h5_gateway\\\/,\s*requires-body=0,\s*max-size=0,\s*timeout=10,/m
    );
    assert.match(
        sgmodule,
        /^ibailian_signin\s*=\s*type=cron,\s*cronexp="\{\{\{cron\}\}\}",\s*wake-system=true,\s*timeout=60,/m
    );
    assert.match(
        sgmodule,
        /^ibailian_panel\s*=\s*type=generic,\s*timeout=60,/m
    );

    // [Panel] 引用存在的 script-name，且不混用 style= 与 icon=
    const panelLine = sgmodule.match(/^ibailian_panel\s*=\s*script-name=([a-z_]+),.+$/m);
    assert.ok(panelLine, '应声明 [Panel] ibailian_panel');
    assert.match(sgmodule, new RegExp(`^${panelLine[1]}\\s*=\\s*type=generic`, 'm'));
    assert.doesNotMatch(panelLine[0], /\bstyle=/);
    assert.match(panelLine[0], /\bicon=gift\.fill\b/);
    assert.match(panelLine[0], /\bicon-color=#FF6B35\b/);
});

test('ibailian 超时预算嵌套且无毫秒误写', () => {
    const sgmodule = readFile('sgmodule');
    const signinSrc = readFile('signin');

    const moduleTimeout = Number(sgmodule.match(/ibailian_signin\s*=[^\n]*timeout=(\d+)/)[1]);
    const requestTimeout = Number(signinSrc.match(/const REQUEST_TIMEOUT = (\d+);/)[1]);

    assert.ok(requestTimeout >= 1 && requestTimeout <= 15, `REQUEST_TIMEOUT (${requestTimeout}) 必须以秒为单位`);
    assert.ok(requestTimeout * 4 < moduleTimeout, `单次请求超时 ${requestTimeout}s 需远小于模块 timeout=${moduleTimeout}s`);
});

test('ibailian 远程 script-path 全部指向 smileyxy/jd_surge/main/ibailian 且本地存在', () => {
    const sgmodule = readFile('sgmodule');
    const urls = [...sgmodule.matchAll(/script-path=(https:\/\/\S+?)(?:,|\s|$)/g)].map((m) => m[1]);
    assert.equal(urls.length, 3);

    for (const url of urls) {
        assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/smileyxy\/jd_surge\/main\/ibailian\/(ibailian_gettoken|ibailian_signin)\.js$/);
        const fileName = path.basename(url);
        assert.ok(fs.existsSync(path.join(ROOT, 'ibailian', fileName)), `本地缺少 ${fileName}`);
    }
});

test('ibailian 两个脚本不包含 Loon / QX 残留 API', () => {
    for (const key of ['gettoken', 'signin']) {
        const src = readFile(key);
        for (const forbidden of ['$loon', '$task', '$notify', '$base64', '$prefs']) {
            assert.equal(src.includes(forbidden), false, `${key} 不应包含 ${forbidden}`);
        }
    }
});

// ============= 2. ibailian_gettoken.js 沙箱测试 =============

test('gettoken：默认写入槽位 1，header 大小写无关，通知与日志均脱敏', async () => {
    const rawToken = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const res = await runGetToken({
        headers: {
            MemberToken: rawToken,
            DeviceKey: 'dev-key-1',
            'SM-DeviceID': 'sm-id-1'
        }
    });

    assert.equal(res.doneCount, 1);
    assert.equal(typeof res.donePayload, 'object');
    assert.notEqual(res.donePayload, null);
    assert.deepEqual(JSON.parse(JSON.stringify(res.donePayload)), {});
    assert.deepEqual(JSON.parse(res.store.IBL_Creds_1), {
        membertoken: rawToken,
        devicekey: 'dev-key-1',
        smDeviceid: 'sm-id-1'
    });
    assert.equal(res.notifications.length, 1);
    assert.equal(res.notifications[0].subtitle, '账号1 已更新');
    assert.equal(res.notifications[0].body.includes(rawToken), false, '通知不能暴露完整 token');
    assert.equal(res.logs.join('\n').includes(rawToken), false, '日志不能暴露完整 token');
});

test('gettoken：通过 $argument="slot=2" 写入槽位 2，未展开占位符时回退 IBL_CaptureSlot', async () => {
    const token2 = '2222222222aaaaaaaabbbbbbbbccccccccdddddddd';
    const resArg = await runGetToken({
        argument: 'slot=2',
        headers: { membertoken: token2 }
    });
    assert.equal(JSON.parse(resArg.store.IBL_Creds_2).membertoken, token2);
    assert.equal(resArg.store.IBL_Creds_1, undefined);
    assert.equal(resArg.notifications[0].subtitle, '账号2 已更新');

    const token3 = '3333333333aaaaaaaabbbbbbbbccccccccdddddddd';
    const resFallback = await runGetToken({
        argument: 'slot={{{capture_slot}}}',
        store: { IBL_CaptureSlot: '3' },
        headers: { membertoken: token3 }
    });
    assert.equal(JSON.parse(resFallback.store.IBL_Creds_3).membertoken, token3);
    assert.equal(resFallback.notifications[0].subtitle, '账号3 已更新');
});

test('gettoken：凭证一致跳过；仅设备标识变更时静默更新不弹通知', async () => {
    const token = '111111222222333333444444555555666666';
    const initial = JSON.stringify({ membertoken: token, devicekey: 'd1', smDeviceid: 's1' });

    const sameRes = await runGetToken({
        store: { IBL_Creds_1: initial },
        headers: { membertoken: token, devicekey: 'd1', 'sm-deviceid': 's1' }
    });
    assert.equal(sameRes.notifications.length, 0);
    assert.equal(sameRes.store.IBL_Creds_1, initial);

    const deviceChangedRes = await runGetToken({
        store: { IBL_Creds_1: initial },
        headers: { membertoken: token, devicekey: 'd2', 'sm-deviceid': 's2' }
    });
    assert.equal(deviceChangedRes.notifications.length, 0);
    assert.deepEqual(JSON.parse(deviceChangedRes.store.IBL_Creds_1), {
        membertoken: token,
        devicekey: 'd2',
        smDeviceid: 's2'
    });
});

test('gettoken：缺少 membertoken 静默退出；写入失败弹出失败通知', async () => {
    const noTokenRes = await runGetToken({
        headers: { devicekey: 'd1' }
    });
    assert.equal(noTokenRes.doneCount, 1);
    assert.equal(noTokenRes.notifications.length, 0);
    assert.equal(Object.keys(noTokenRes.store).length, 0);

    const writeFailRes = await runGetToken({
        headers: { membertoken: 'tok_abcdef1234567890' },
        writeOk: false
    });
    assert.equal(writeFailRes.doneCount, 1);
    assert.equal(writeFailRes.notifications.length, 1);
    assert.equal(writeFailRes.notifications[0].subtitle, '账号1 保存失败');
});

// ============= 3. ibailian_signin.js 沙箱测试 =============

test('signin：明文 JSON 签到 + 仅执行未完成任务 + timeout 为 8 秒 + 写 IBL_LastRun', async () => {
    const creds1 = {
        membertoken: 'tok_account_1_secret_value',
        devicekey: 'dk1',
        smDeviceid: 'sm1'
    };

    const res = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=all',
        store: { IBL_Creds_1: JSON.stringify(creds1) },
        postHandler: (opts, cb) => {
            assert.equal(opts.timeout, 8, 'Surge timeout 必须为 8 秒');
            assert.equal(opts.headers.membertoken, creds1.membertoken);
            assert.equal(opts.headers.devicekey, 'dk1');
            assert.equal(opts.headers['sm-deviceid'], 'sm1');

            if (opts.url.endsWith('/signIn/submitSignInv2.htm')) {
                assert.equal(opts.body, '{"channelId":1,"buId":"3000","shopId":"-1"}');
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ signStatus: '0', signPoint: '5', keepDays: 7 })
                }));
            } else if (opts.url.endsWith('/signIn/getTaskListv2.htm')) {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({
                        pointTaskList: [
                            { taskCode: 'T_DONE', taskId: 10, taskName: '已完成浏览', buttonText: '已完成', pointValues: '2' },
                            { taskCode: 'T_TODO', taskId: 14, taskName: '逛逛好物', buttonText: '去完成', pointValues: '2' }
                        ]
                    })
                }));
            } else if (opts.url.endsWith('/jkTask/addTaskv2.htm')) {
                const payload = JSON.parse(opts.body);
                assert.equal(payload.taskCode, 'T_TODO');
                assert.equal(payload.actId, 'T_TODO');
                assert.equal(payload.taskId, '14');
                assert.equal(payload.memberToken, creds1.membertoken);
                cb(null, { status: 200 }, JSON.stringify({ resCode: '00100000', obj: '{}' }));
            } else {
                cb('unknown url', null, '');
            }
        }
    });

    assert.equal(res.doneCount, 1);
    assert.equal(res.requests.length, 3);
    assert.equal(res.notifications.length, 1);
    assert.equal(res.notifications[0].subtitle, '共 1 个账号，总计 +7 积分');
    assert.match(res.notifications[0].body, /签到成功 \+5积分（连续7天）/);
    assert.match(res.notifications[0].body, /任务：完成1个 失败0个 共\+2积分/);
    assert.ok(res.logs.some((line) => line.includes('逛逛好物') && line.includes('完成 +2积分')));
    assert.equal(res.logs.join('\n').includes(creds1.membertoken), false, '日志不应打印明文 token');

    const lastRun = JSON.parse(res.store.IBL_LastRun);
    assert.equal(lastRun.totalPoints, 7);
    assert.equal(lastRun.hasError, false);
    assert.equal(lastRun.accountCount, 1);
});

test('signin：纯 JSC 下 Base64 中文响应解码（覆盖无 =、1 个 =、2 个 = 补位）', async () => {
    const signPayload = encodeBase64WithPadding({
        resCode: '00100000',
        obj: JSON.stringify({ signStatus: '0', signPoint: '3', keepDays: 2, msg: '签到中文测试' })
    }, 0);
    const listPayload = encodeBase64WithPadding({
        resCode: '00100000',
        obj: JSON.stringify({
            pointTaskList: [
                { taskCode: 'T1', taskId: 18, taskName: '中文任务名称测试', buttonText: '去浏览', pointValues: '2' }
            ]
        })
    }, 1);
    const taskPayload = encodeBase64WithPadding({
        resCode: '00100000',
        obj: JSON.stringify({ tip: '完成中文补位' })
    }, 2);

    assert.equal(signPayload.endsWith('='), false);
    assert.match(listPayload, /[^=]=$/);
    assert.equal(taskPayload.endsWith('=='), true);

    const res = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=all',
        store: { IBL_Creds_1: JSON.stringify({ membertoken: 'tok_base64_test_1234' }) },
        postHandler: (opts, cb) => {
            if (opts.url.endsWith('/signIn/submitSignInv2.htm')) {
                cb(null, { status: 200 }, signPayload);
            } else if (opts.url.endsWith('/signIn/getTaskListv2.htm')) {
                cb(null, { status: 200 }, listPayload);
            } else if (opts.url.endsWith('/jkTask/addTaskv2.htm')) {
                cb(null, { status: 200 }, taskPayload);
            }
        }
    });

    assert.equal(res.doneCount, 1);
    assert.equal(res.notifications[0].subtitle, '共 1 个账号，总计 +5 积分');
    assert.ok(res.logs.some((line) => line.includes('中文任务名称测试')));
});

test('signin：多账号包含异常槽位时隔离互不影响并标记 hasError', async () => {
    const res = await runSignIn({
        argument: 'mode=cron&account_count=3&notify_mode=all',
        store: {
            IBL_Creds_1: JSON.stringify({ membertoken: 'tok_valid_1_12345678' }),
            IBL_Creds_2: '{bad json'
            // IBL_Creds_3 缺失
        },
        postHandler: (opts, cb) => {
            if (opts.url.endsWith('/signIn/submitSignInv2.htm')) {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ signStatus: '1' })
                }));
            } else if (opts.url.endsWith('/signIn/getTaskListv2.htm')) {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ pointTaskList: [] })
                }));
            }
        }
    });

    assert.equal(res.doneCount, 1);
    assert.equal(res.requests.length, 2);
    const lastRun = JSON.parse(res.store.IBL_LastRun);
    assert.equal(lastRun.hasError, true);
    assert.equal(lastRun.totalPoints, 0);
    assert.match(res.notifications[0].body, /账号1\(0积分\): 今日已签到/);
    assert.match(res.notifications[0].body, /账号2: 凭证格式错误/);
    assert.match(res.notifications[0].body, /账号3: 未配置凭证/);
});

test('signin：4 种 notify_mode 在无新积分 / 得积分 / 有报错场景下行为准确', async () => {
    const validStore = { IBL_Creds_1: JSON.stringify({ membertoken: 'tok_notify_test_1234' }) };

    const makeHandler = (pts, signFail) => (opts, cb) => {
        if (opts.url.endsWith('/signIn/submitSignInv2.htm')) {
            if (signFail) {
                cb(null, { status: 200 }, JSON.stringify({ resCode: '9999', msg: '凭证无效' }));
            } else if (pts > 0) {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ signStatus: '0', signPoint: String(pts), keepDays: 1 })
                }));
            } else {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ signStatus: '1' })
                }));
            }
        } else if (opts.url.endsWith('/signIn/getTaskListv2.htm')) {
            cb(null, { status: 200 }, JSON.stringify({
                resCode: '00100000',
                obj: JSON.stringify({ pointTaskList: [] })
            }));
        }
    };

    // all: 无积分也通知
    const allZero = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=all',
        store: { ...validStore },
        postHandler: makeHandler(0, false)
    });
    assert.equal(allZero.notifications.length, 1);

    // smart: 无积分无报错跳过通知；有积分或报错则通知
    const smartZero = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=smart',
        store: { ...validStore },
        postHandler: makeHandler(0, false)
    });
    assert.equal(smartZero.notifications.length, 0);

    const smartGain = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=smart',
        store: { ...validStore },
        postHandler: makeHandler(2, false)
    });
    assert.equal(smartGain.notifications.length, 1);

    // error: 有积分无报错跳过；有报错才通知
    const errorGain = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=error',
        store: { ...validStore },
        postHandler: makeHandler(2, false)
    });
    assert.equal(errorGain.notifications.length, 0);

    const errorFail = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=error',
        store: { ...validStore },
        postHandler: makeHandler(0, true)
    });
    assert.equal(errorFail.notifications.length, 1);

    // off: 有报错也不发通知
    const offFail = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=off',
        store: { ...validStore },
        postHandler: makeHandler(0, true)
    });
    assert.equal(offFail.notifications.length, 0);
});

test('signin：Panel 自动刷新只读本地状态（零请求），点击按钮立即签到并更新面板', async () => {
    const store = {
        IBL_Creds_1: JSON.stringify({ membertoken: 'tok_panel_test_123456' })
    };

    const autoRefresh = await runSignIn({
        argument: 'mode=panel&account_count=1&notify_mode=all',
        input: { purpose: 'panel', panelName: 'ibailian_panel' },
        store
    });
    assert.equal(autoRefresh.doneCount, 1);
    assert.equal(autoRefresh.requests.length, 0, '自动刷新禁止发起网络请求');
    assert.equal(autoRefresh.notifications.length, 0);
    assert.equal(autoRefresh.donePayload.title, 'i百联每日签到');
    assert.equal(autoRefresh.donePayload.icon, 'gift.fill');
    assert.equal(autoRefresh.donePayload['icon-color'], '#FF6B35');
    assert.match(autoRefresh.donePayload.content, /账号1: ✅ 就绪/);
    assert.match(autoRefresh.donePayload.content, /上次执行: 暂无记录/);

    const buttonTrigger = await runSignIn({
        argument: 'mode=panel&account_count=1&notify_mode=all',
        input: { purpose: 'panel', panelName: 'ibailian_panel' },
        trigger: 'button',
        store,
        postHandler: (opts, cb) => {
            if (opts.url.endsWith('/signIn/submitSignInv2.htm')) {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ signStatus: '0', signPoint: '4', keepDays: 4 })
                }));
            } else if (opts.url.endsWith('/signIn/getTaskListv2.htm')) {
                cb(null, { status: 200 }, JSON.stringify({
                    resCode: '00100000',
                    obj: JSON.stringify({ pointTaskList: [] })
                }));
            }
        }
    });
    assert.equal(buttonTrigger.doneCount, 1);
    assert.equal(buttonTrigger.requests.length, 2);
    assert.equal(buttonTrigger.notifications.length, 0, '手动点击面板不重复弹系统通知');
    assert.equal(buttonTrigger.donePayload.icon, 'gift.fill');
    assert.equal(buttonTrigger.donePayload['icon-color'], '#34C759');
    assert.match(buttonTrigger.donePayload.content, /总计 \+4 积分/);
    assert.ok(store.IBL_LastRun, '按钮触发后应更新 IBL_LastRun');
});

test('signin：网络异常与 HTTP 500 不挂起，正确标记失败并调用 $done()', async () => {
    const res = await runSignIn({
        argument: 'mode=cron&account_count=1&notify_mode=all',
        store: { IBL_Creds_1: JSON.stringify({ membertoken: 'tok_network_error_1234' }) },
        postHandler: (opts, cb) => {
            if (opts.url.endsWith('/signIn/submitSignInv2.htm')) {
                cb('Request timeout', null, '');
            } else if (opts.url.endsWith('/signIn/getTaskListv2.htm')) {
                cb(null, { status: 500 }, 'Internal Server Error');
            }
        }
    });

    assert.equal(res.doneCount, 1);
    const lastRun = JSON.parse(res.store.IBL_LastRun);
    assert.equal(lastRun.hasError, true);
    assert.equal(res.notifications.length, 1);
    assert.match(res.notifications[0].body, /签到失败: 请求异常 - Request timeout/);
    assert.match(res.notifications[0].body, /获取任务列表失败：HTTP 500/);
});
