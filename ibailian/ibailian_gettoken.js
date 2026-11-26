/**
 * i百联 - Token 自动抓取（Surge 专用版）
 *
 * 功能：拦截 mh5.bl.com/h5_gateway/ 请求，提取 membertoken + devicekey + sm-deviceid，
 *       组合为 JSON 凭证持久化到 IBL_Creds_{slot}。
 *       - 仅当 membertoken 变化时才弹通知（devicekey / sm-deviceid 变化静默更新）
 *       - 凭证完全相同时静默跳过
 *       - 默认写入账号1，可通过模块参数 capture_slot（或 IBL_CaptureSlot）切换槽位
 */

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

function resolveSlot(args) {
  const fromArg = parsePositiveInt(args.slot);
  if (fromArg) return fromArg;
  const fromStore = parsePositiveInt($persistentStore.read("IBL_CaptureSlot"));
  if (fromStore) return fromStore;
  return 1;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  for (const key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return null;
}

function maskToken(token) {
  if (!token || typeof token !== "string") return "****";
  if (token.length <= 10) return "****";
  return token.slice(0, 6) + "****" + token.slice(-4);
}

(function main() {
  try {
    const headers = typeof $request !== "undefined" && $request ? $request.headers : null;
    const token = getHeader(headers, "membertoken");
    if (!token) {
      return;
    }

    const args = parseArgument(typeof $argument !== "undefined" ? $argument : "");
    const slot = resolveSlot(args);
    const storeKey = "IBL_Creds_" + slot;

    const newCreds = {
      membertoken: String(token),
      devicekey: String(getHeader(headers, "devicekey") || ""),
      smDeviceid: String(getHeader(headers, "sm-deviceid") || "")
    };
    const newStr = JSON.stringify(newCreds);
    const saved = $persistentStore.read(storeKey);

    if (saved === newStr) {
      console.log("⏭️ 账号" + slot + " 凭证无变化，跳过");
      return;
    }

    let oldToken = "";
    if (saved) {
      try {
        const oldCreds = JSON.parse(saved);
        oldToken = oldCreds && oldCreds.membertoken ? String(oldCreds.membertoken) : "";
      } catch (e) {
        oldToken = "";
      }
    }

    const ok = $persistentStore.write(newStr, storeKey);
    const masked = maskToken(newCreds.membertoken);

    if (oldToken !== newCreds.membertoken) {
      if (ok) {
        console.log("✅ 账号" + slot + " Token 已更新 (" + masked + ")");
        $notification.post("i百联 Token", "账号" + slot + " 已更新", "凭证已保存 (" + masked + ")");
      } else {
        console.log("❌ 账号" + slot + " 凭证写入持久化存储失败");
        $notification.post("i百联 Token", "账号" + slot + " 保存失败", "写入持久化存储失败");
      }
    } else if (ok) {
      console.log("🔄 账号" + slot + " 设备标识已静默更新 (" + masked + ")");
    } else {
      console.log("❌ 账号" + slot + " 设备标识更新失败（写入持久化存储失败）");
    }
  } catch (err) {
    console.log("❌ i百联 Token 抓取异常: " + (err && err.message ? err.message : String(err)));
  } finally {
    $done({});
  }
})();
