/**
 * i百联 - 每日签到 + 积分任务 + 信息面板（Surge 专用版）
 *
 * 功能：
 *   1. 每日签到赚积分（连续签到递增，7天档最高 5 积分）
 *   2. 自动完成所有未完成的浏览类积分任务
 *   3. 支持 Surge 模块参数（account_count / notify_mode / mode）及持久化存储兜底
 *   4. 支持 Surge [Panel] 单面板智能交互：自动刷新仅读本地状态，手动点击立即执行签到
 */

// Surge $httpClient 的 timeout 单位为秒，必须严格小于模块中 script 的 timeout (60s)
const REQUEST_TIMEOUT = 8;
const BASE_URL = "https://mh5.bl.com/h5_gateway";
const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 djAppVersion=9.20.0 iBailian";
const VALID_NOTIFY_MODES = { all: true, smart: true, error: true, off: true };
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let doneCalled = false;
function finishDone(payload) {
  if (doneCalled) return;
  doneCalled = true;
  if (payload !== undefined) {
    $done(payload);
  } else {
    $done();
  }
}

function safeDecode(val) {
  try {
    return decodeURIComponent(val);
  } catch (e) {
    return val;
  }
}

function parseArgument(raw) {
  const result = {};
  if (typeof raw !== "string") return result;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return result;

  const parts = cleaned.split("&");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = safeDecode(part.slice(0, eqIdx).trim());
    const val = safeDecode(part.slice(eqIdx + 1).trim());
    if (!key || !val || /^\{\{\{.*\}\}\}$/.test(val)) continue;
    result[key] = val;
  }
  return result;
}

function parsePositiveInt(val) {
  if (val === undefined || val === null) return 0;
  const str = String(val).trim();
  if (!/^\d+$/.test(str)) return 0;
  const num = parseInt(str, 10);
  return num >= 1 ? num : 0;
}

function resolveAccountCount(args) {
  const fromArg = parsePositiveInt(args.account_count);
  if (fromArg) return fromArg;
  const fromStore = parsePositiveInt($persistentStore.read("IBL_AccountCount"));
  if (fromStore) return fromStore;
  return 1;
}

function resolveNotifyMode(args) {
  if (args.notify_mode) {
    const m = String(args.notify_mode).trim().toLowerCase();
    if (VALID_NOTIFY_MODES[m]) return m;
  }
  const saved = $persistentStore.read("IBL_NotifyMode");
  if (saved) {
    const m = String(saved).trim().toLowerCase();
    if (VALID_NOTIFY_MODES[m]) return m;
  }
  return "all";
}

function resolveMode(args) {
  if (args.mode === "panel") return "panel";
  if (typeof $input !== "undefined" && $input && $input.purpose === "panel") return "panel";
  return "cron";
}

function shouldNotify(notifyMode, stats) {
  if (notifyMode === "off") return false;
  if (notifyMode === "error") return Boolean(stats.hasError);
  if (notifyMode === "smart") return Boolean(stats.hasError || stats.totalPoints > 0);
  return true;
}

function maskToken(token) {
  if (!token || typeof token !== "string") return "****";
  if (token.length <= 10) return "****";
  return token.slice(0, 6) + "****" + token.slice(-4);
}

function pad2(num) {
  return num < 10 ? "0" + num : String(num);
}

function formatTime(date) {
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate()) +
    " " +
    pad2(date.getHours()) +
    ":" +
    pad2(date.getMinutes()) +
    ":" +
    pad2(date.getSeconds())
  );
}

// === 纯 JS Base64 + UTF-8 解码（兼容 Surge JSC 无内置 Base64 API 环境，修复补位 \0 Bug） ===
function utf8Decode(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc2 && b < 0xe0) {
      if (i >= bytes.length) throw new Error("Invalid UTF-8 sequence");
      const b2 = bytes[i++];
      out += String.fromCharCode(((b & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      if (i + 1 >= bytes.length) throw new Error("Invalid UTF-8 sequence");
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      out += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (i + 2 >= bytes.length) throw new Error("Invalid UTF-8 sequence");
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      let cp = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      throw new Error("Invalid UTF-8 byte");
    }
  }
  return out;
}

function b64decode(str) {
  const clean = String(str).replace(/\s+/g, "").replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!clean) return "";
  if (clean.length % 4 === 1) throw new Error("Invalid Base64 length");

  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = BASE64_CHARS.indexOf(clean.charAt(i));
    const c2 = i + 1 < clean.length ? BASE64_CHARS.indexOf(clean.charAt(i + 1)) : -1;
    if (c1 < 0 || c2 < 0) throw new Error("Invalid Base64 char");
    bytes.push((c1 << 2) | (c2 >> 4));

    if (i + 2 < clean.length) {
      const c3 = BASE64_CHARS.indexOf(clean.charAt(i + 2));
      if (c3 < 0) throw new Error("Invalid Base64 char");
      bytes.push(((c2 & 15) << 4) | (c3 >> 2));

      if (i + 3 < clean.length) {
        const c4 = BASE64_CHARS.indexOf(clean.charAt(i + 3));
        if (c4 < 0) throw new Error("Invalid Base64 char");
        bytes.push(((c3 & 3) << 6) | c4);
      }
    }
  }
  return utf8Decode(bytes);
}

// === 解析响应（明文 JSON 或 Base64 编码 JSON） ===
function parseResponse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    try {
      const decoded = b64decode(text);
      if (!decoded) return null;
      data = JSON.parse(decoded);
    } catch (e2) {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;

  if (typeof data.obj === "string" && data.obj) {
    try {
      data._obj = JSON.parse(data.obj);
    } catch (e) {
      data._obj = {};
    }
  }
  return data;
}

// === 请求封装 ===
function buildHeaders(creds) {
  const h = {
    "content-type": "application/json",
    "channelid": "1",
    "chnflg": "app-h5",
    "membertoken": creds.membertoken,
    "origin": "https://mh5.bl.com",
    "referer": "https://mh5.bl.com/bl-front-end/pages/mypoints/myPoints?hidebar=true&blappversion=9.20.0",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": DEFAULT_UA
  };
  if (creds.devicekey) h["devicekey"] = creds.devicekey;
  if (creds.smDeviceid) h["sm-deviceid"] = creds.smDeviceid;
  return h;
}

function postGateway(path, creds, body, callback) {
  $httpClient.post(
    {
      url: BASE_URL + path,
      timeout: REQUEST_TIMEOUT,
      headers: buildHeaders(creds),
      body: body
    },
    function (errormsg, response, data) {
      if (errormsg) {
        callback("请求异常 - " + errormsg, null);
        return;
      }
      const status = response && (response.status || response.statusCode);
      const parsed = parseResponse(data);
      if (!parsed) {
        callback(status && status >= 400 ? "HTTP " + status : "响应解析失败", null);
        return;
      }
      if (status && status >= 400 && parsed.resCode !== "00100000") {
        const inner = parsed._obj || {};
        const msg = inner.errMsg || parsed.errMsg || parsed.msg || ("HTTP " + status);
        callback(msg, null);
        return;
      }
      callback(null, parsed);
    }
  );
}

// === 1. 每日签到 ===
function doSignIn(creds, callback) {
  const body = '{"channelId":1,"buId":"3000","shopId":"-1"}';
  postGateway("/signIn/submitSignInv2.htm", creds, body, function (err, parsed) {
    if (err) {
      callback({ ok: false, message: "签到失败: " + err, points: 0 });
      return;
    }
    if (parsed.resCode === "00100000") {
      const obj = parsed._obj || {};
      if (obj.signStatus === "1") {
        callback({ ok: true, message: "今日已签到", points: 0 });
      } else {
        const pts = parseInt(obj.signPoint, 10) || 0;
        callback({
          ok: true,
          message: "签到成功 +" + pts + "积分（连续" + (obj.keepDays || "?") + "天）",
          points: pts
        });
      }
      return;
    }
    const inner = parsed._obj || {};
    const msg = inner.errMsg || parsed.errMsg || parsed.msg || ("resCode " + parsed.resCode);
    callback({ ok: false, message: "签到失败: " + msg, points: 0 });
  });
}

// === 2. 获取任务列表 ===
function getTaskList(creds, callback) {
  postGateway("/signIn/getTaskListv2.htm", creds, "{}", function (err, parsed) {
    if (err) {
      callback("获取任务列表失败：" + err, []);
      return;
    }
    if (parsed.resCode !== "00100000") {
      const inner = parsed._obj || {};
      const errMsg = inner.errMsg || parsed.msg || parsed.errMsg || ("错误码 " + parsed.resCode);
      callback("获取任务列表失败：" + errMsg, []);
      return;
    }
    const obj = parsed._obj || {};
    const tasks = Array.isArray(obj.pointTaskList) ? obj.pointTaskList : [];
    callback(null, tasks);
  });
}

// === 3. 完成单个任务 ===
function doTask(creds, task, callback) {
  const body = JSON.stringify({
    actId: task.taskCode,
    taskCode: task.taskCode,
    taskId: String(task.taskId || "14"),
    memberToken: creds.membertoken
  });
  postGateway("/jkTask/addTaskv2.htm", creds, body, function (err, parsed) {
    if (err) {
      callback(false, err);
      return;
    }
    if (parsed.resCode === "00100000") {
      callback(true, "完成 +" + (task.pointValues || "?") + "积分");
      return;
    }
    const inner = parsed._obj || {};
    const msg = inner.errMsg || parsed.errMsg || parsed.msg || ("resCode " + parsed.resCode);
    callback(false, msg);
  });
}

// === 4. 执行全部未完成任务 ===
function doAllTasks(creds, label, callback) {
  getTaskList(creds, function (err, tasks) {
    if (err) {
      console.log("❌ [" + label + "] " + err);
      callback({ ok: false, message: err, points: 0, total: 0 });
      return;
    }

    const todo = [];
    const done = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t && t.buttonText === "已完成") {
        done.push(t);
      } else if (t) {
        todo.push(t);
      }
    }

    if (todo.length === 0) {
      console.log("⏭️ [" + label + "] 任务已全部完成 (" + done.length + "/" + tasks.length + ")");
      callback({
        ok: true,
        message: "任务：已完成 " + done.length + "/" + tasks.length + "（无待做任务）",
        points: 0,
        total: tasks.length
      });
      return;
    }

    let taskPoints = 0;
    let taskDone = 0;
    let taskFail = 0;

    function processTask(idx) {
      if (idx >= todo.length) {
        const summary = "任务：完成" + taskDone + "个 失败" + taskFail + "个 共+" + taskPoints + "积分";
        callback({ ok: taskFail === 0, message: summary, points: taskPoints, total: tasks.length });
        return;
      }

      const task = todo[idx];
      const taskLabel = task.taskName || task.taskCode || ("任务" + (idx + 1));
      doTask(creds, task, function (ok, msg) {
        if (ok) {
          taskDone++;
          taskPoints += parseInt(task.pointValues, 10) || 0;
          console.log("  ✅ [" + label + "] " + taskLabel + " " + msg);
        } else {
          taskFail++;
          console.log("  ❌ [" + label + "] " + taskLabel + " " + msg);
        }
        processTask(idx + 1);
      });
    }

    processTask(0);
  });
}

// === Panel 本地状态检查（零网络请求） ===
function inspectAccountCreds(accountCount) {
  const list = [];
  for (let i = 1; i <= accountCount; i++) {
    const raw = $persistentStore.read("IBL_Creds_" + i);
    const label = "账号" + i;
    if (!raw) {
      list.push({ index: i, status: "missing", text: label + ": ⚠️ 未配置凭证" });
      continue;
    }
    try {
      const creds = JSON.parse(raw);
      if (!creds || !creds.membertoken) {
        list.push({ index: i, status: "invalid", text: label + ": ❌ 缺少 membertoken" });
      } else {
        list.push({
          index: i,
          status: "ready",
          text: label + ": ✅ 就绪 (" + maskToken(String(creds.membertoken)) + ")"
        });
      }
    } catch (e) {
      list.push({ index: i, status: "invalid", text: label + ": ❌ 凭证格式错误" });
    }
  }
  return list;
}

function readLastRun() {
  const raw = $persistentStore.read("IBL_LastRun");
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  }
}

function renderPanelStatusOnly(accountCount) {
  const accounts = inspectAccountCreds(accountCount);
  const lastRun = readLastRun();
  let hasConfigIssue = false;

  const lines = [];
  for (let i = 0; i < accounts.length; i++) {
    if (accounts[i].status !== "ready") hasConfigIssue = true;
    lines.push(accounts[i].text);
  }

  if (lastRun) {
    lines.push("上次执行: " + (lastRun.time || "未知") + " (+" + (lastRun.totalPoints || 0) + " 积分)");
    if (Array.isArray(lastRun.results) && lastRun.results.length > 0) {
      for (let i = 0; i < lastRun.results.length; i++) {
        lines.push(lastRun.results[i]);
      }
    }
  } else {
    lines.push("上次执行: 暂无记录");
  }
  lines.push("点击面板立即执行签到与积分任务");

  let icon = "gift.fill";
  let iconColor = "#FF6B35";
  if (hasConfigIssue) {
    icon = "exclamationmark.triangle.fill";
    iconColor = "#FF9500";
  } else if (lastRun && lastRun.hasError) {
    icon = "xmark.circle.fill";
    iconColor = "#FF3B30";
  } else if (lastRun) {
    icon = "gift.fill";
    iconColor = "#34C759";
  }

  console.log("🔄 i百联面板只读刷新完成（" + accountCount + " 个账号）");
  finishDone({
    title: "i百联每日签到",
    content: lines.join("\n"),
    icon: icon,
    "icon-color": iconColor
  });
}

// === 主执行流程 ===
function runAccounts(accountCount, notifyMode, isPanelButton) {
  const results = [];
  let totalPoints = 0;
  let hasError = false;
  let currentIndex = 1;

  function processAccount(index, callback) {
    const storeKey = "IBL_Creds_" + index;
    const raw = $persistentStore.read(storeKey);
    const label = "账号" + index;

    if (!raw) {
      hasError = true;
      console.log("⚠️ " + label + " 未配置凭证");
      results.push(label + ": 未配置凭证");
      callback();
      return;
    }

    let creds;
    try {
      creds = JSON.parse(raw);
    } catch (e) {
      hasError = true;
      console.log("❌ " + label + " 凭证 JSON 解析失败");
      results.push(label + ": 凭证格式错误");
      callback();
      return;
    }

    if (!creds || !creds.membertoken) {
      hasError = true;
      console.log("❌ " + label + " 凭证缺少 membertoken");
      results.push(label + ": 缺少 membertoken");
      callback();
      return;
    }

    console.log("🔄 开始执行 " + label + " (" + maskToken(String(creds.membertoken)) + ")");
    let accountPoints = 0;
    const lines = [];

    doSignIn(creds, function (signRes) {
      if (!signRes.ok) hasError = true;
      accountPoints += signRes.points;
      lines.push(signRes.message);
      console.log((signRes.ok ? "✅ " : "❌ ") + label + " " + signRes.message);

      doAllTasks(creds, label, function (taskRes) {
        if (!taskRes.ok) hasError = true;
        accountPoints += taskRes.points;
        lines.push(taskRes.message);
        totalPoints += accountPoints;

        const summaryLine = label + "(" + accountPoints + "积分): " + lines.join(" | ");
        results.push(summaryLine);
        callback();
      });
    });
  }

  function processNext() {
    if (currentIndex > accountCount) {
      const timeStr = formatTime(new Date());
      const lastRun = {
        time: timeStr,
        accountCount: accountCount,
        totalPoints: totalPoints,
        hasError: hasError,
        results: results
      };
      $persistentStore.write(JSON.stringify(lastRun), "IBL_LastRun");

      const summary = results.join("\n");
      const sub = "共 " + accountCount + " 个账号，总计 +" + totalPoints + " 积分";
      console.log((hasError ? "⚠️ " : "✅ ") + "i百联执行完毕：" + sub);

      if (isPanelButton) {
        finishDone({
          title: "i百联每日签到",
          content: "本次完成 (" + timeStr + ") | 总计 +" + totalPoints + " 积分\n" + summary,
          icon: hasError ? "xmark.circle.fill" : "gift.fill",
          "icon-color": hasError ? "#FF3B30" : "#34C759"
        });
        return;
      }

      if (shouldNotify(notifyMode, { hasError: hasError, totalPoints: totalPoints })) {
        $notification.post("i百联签到+任务", sub, summary);
      } else {
        console.log("⏭️ 通知策略为 " + notifyMode + "，本次跳过系统推送");
      }
      finishDone();
      return;
    }

    processAccount(currentIndex, function () {
      currentIndex++;
      processNext();
    });
  }

  processNext();
}

(function main() {
  try {
    const args = parseArgument(typeof $argument !== "undefined" ? $argument : "");
    const mode = resolveMode(args);
    const isPanelButton = mode === "panel" && typeof $trigger !== "undefined" && $trigger === "button";
    const accountCount = resolveAccountCount(args);
    const notifyMode = resolveNotifyMode(args);

    if (mode === "panel" && !isPanelButton) {
      renderPanelStatusOnly(accountCount);
      return;
    }

    runAccounts(accountCount, notifyMode, isPanelButton);
  } catch (err) {
    console.log("❌ i百联脚本运行异常: " + (err && err.message ? err.message : String(err)));
    if (typeof $input !== "undefined" && $input && $input.purpose === "panel") {
      finishDone({
        title: "i百联每日签到",
        content: "❌ 执行异常：" + (err && err.message ? err.message : String(err)),
        icon: "xmark.circle.fill",
        "icon-color": "#FF3B30"
      });
    } else {
      finishDone();
    }
  }
})();
