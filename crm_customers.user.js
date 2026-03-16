// ==UserScript==
// @name         CRM 客户维护提示弹窗（云端数据版）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  从 GitHub+jsDelivr 读取客户维护信息，在客户详情页显示可拖拽弹窗。数据通过 JSON 云端维护，销售脚本长期不需要更新。
// @author       YOU
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  /*****************************************************************
   * 可配置常量（在给销售之前由你一次性设置好，之后长期不改动）
   *****************************************************************/

  // TODO: 使用前请将下面的 user/repo@branch 替换为你自己的 GitHub 仓库信息
  // 例如: https://cdn.jsdelivr.net/gh/your-name/your-repo@main/customers.json
  const DATA_CDN_URLS = [
    "https://cdn.jsdelivr.net/gh/your-name/your-repo@main/customers.json",
    "https://fastly.jsdelivr.net/gh/your-name/your-repo@main/customers.json",
    "https://gcore.jsdelivr.net/gh/your-name/your-repo@main/customers.json",
  ];

  // localStorage 缓存配置
  const CACHE_KEY = "crm-cloud-data-cache";
  const CACHE_DURATION = 30 * 60 * 1000; // 30 分钟

  // 单个 CDN 请求的超时时间（毫秒）
  const REQUEST_TIMEOUT = 5000;

  // 调试开关：设为 true 可在控制台看到调试日志
  const DEBUG = true;

  // 简单的 URL 匹配规则：避免在无关页面执行
  // 建议你根据自己 CRM 的域名和路径进行修改
  const CRM_HOST_KEYWORDS = [
    // 示例："crm-example.com"
  ];

  /*****************************************************************
   * 工具函数
   *****************************************************************/

  function log(...args) {
    if (DEBUG) {
      console.log("[CRM-Cloud]", ...args);
    }
  }

  function warn(...args) {
    console.warn("[CRM-Cloud]", ...args);
  }

  function isOnCrmPage() {
    if (!CRM_HOST_KEYWORDS.length) {
      // 如果你还没配置域名，则全站生效（不推荐长期使用）
      return true;
    }
    const host = window.location.hostname;
    return CRM_HOST_KEYWORDS.some((kw) => host.includes(kw));
  }

  // 从 URL 中提取 CustomerID
  function extractCustomerIdFromUrl() {
    const url = window.location.href;

    // 1. 优先从查询参数中获取 ?customerId=123456 这种形式
    try {
      const u = new URL(url);
      const searchParams = u.searchParams;
      const paramNames = ["customerId", "id", "customer_id", "custId"];
      for (const name of paramNames) {
        const value = searchParams.get(name);
        if (value && /^\d+$/.test(value)) {
          return value;
        }
      }
    } catch (e) {
      // ignore
    }

    // 2. 从路径中提取最后一个较长的纯数字段
    const path = window.location.pathname;
    const segments = path.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (/^\d{4,}$/.test(seg)) {
        return seg;
      }
    }

    // 3. 兜底：从整条 URL 中找最长的数字串
    const matches = url.match(/\d{4,}/g);
    if (matches && matches.length > 0) {
      return matches[matches.length - 1];
    }

    return null;
  }

  /*****************************************************************
   * 缓存读写
   *****************************************************************/

  function getCacheRaw() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      return JSON.parse(cached);
    } catch (e) {
      warn("读取缓存失败", e);
      return null;
    }
  }

  function getValidCache() {
    const raw = getCacheRaw();
    if (!raw) return null;
    const { data, timestamp } = raw;
    if (!data || !timestamp) return null;
    if (Date.now() - timestamp < CACHE_DURATION) {
      return data;
    }
    return null;
  }

  function setCache(data) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          data,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      warn("写入缓存失败", e);
    }
  }

  /*****************************************************************
   * 网络请求：带超时的 fetch + CDN 轮询
   *****************************************************************/

  function fetchWithTimeout(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error("请求超时"));
      }, timeoutMs);

      fetch(url, { signal: controller.signal })
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async function fetchDataWithFallback() {
    for (const url of DATA_CDN_URLS) {
      try {
        log("尝试请求 CDN:", url);
        const response = await fetchWithTimeout(url, REQUEST_TIMEOUT);
        if (!response.ok) {
          warn("CDN 返回非 2xx 状态:", url, response.status);
          continue;
        }
        const data = await response.json();
        log("CDN 请求成功:", url);
        return data;
      } catch (e) {
        warn("CDN 请求失败:", url, e && e.message ? e.message : e);
      }
    }
    return null;
  }

  /*****************************************************************
   * 客户数据查找
   *****************************************************************/

  function getCustomerData(customers, customerId) {
    if (customers && customerId && customers[customerId]) {
      return customers[customerId];
    }
    return null;
  }

  /*****************************************************************
   * 弹窗渲染
   *****************************************************************/

  function createStyles() {
    if (document.getElementById("crm-cloud-style")) return;
    const style = document.createElement("style");
    style.id = "crm-cloud-style";
    style.textContent = `
.crm-cloud-popup {
  position: fixed;
  top: 80px;
  right: 40px;
  width: 360px;
  background: #ffffff;
  box-shadow: 0 12px 30px rgba(15, 35, 95, 0.18);
  border-radius: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  color: #1f2933;
  z-index: 999999;
  border: 1px solid rgba(15, 35, 95, 0.08);
  box-sizing: border-box;
}
.crm-cloud-header {
  cursor: move;
  padding: 10px 12px;
  background: linear-gradient(90deg, #2563eb, #4f46e5);
  color: #ffffff;
  border-radius: 10px 10px 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.crm-cloud-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
}
.crm-cloud-title-icon {
  width: 18px;
  height: 18px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.crm-cloud-close {
  cursor: pointer;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.9);
  font-size: 14px;
  padding: 0;
  line-height: 1;
}
.crm-cloud-body {
  padding: 12px 14px 10px;
}
.crm-cloud-label {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}
.crm-cloud-direction-box {
  background: #f3f4ff;
  border-radius: 8px;
  padding: 10px 10px;
  border: 1px solid rgba(79, 70, 229, 0.2);
  max-height: 150px;
  overflow-y: auto;
}
.crm-cloud-direction-text {
  font-size: 13px;
  color: #111827;
  line-height: 1.6;
  white-space: pre-wrap;
}
.crm-cloud-empty {
  font-size: 13px;
  color: #9ca3af;
}
.crm-cloud-footer {
  padding: 8px 14px 10px;
  border-top: 1px solid rgba(15, 23, 42, 0.05);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.crm-cloud-link-btn {
  padding: 6px 10px;
  border-radius: 999px;
  border: none;
  background: linear-gradient(90deg, #2563eb, #4f46e5);
  color: #ffffff;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.crm-cloud-link-btn-icon {
  font-size: 13px;
}
.crm-cloud-meta {
  flex: 1;
  text-align: right;
  font-size: 11px;
  color: #9ca3af;
}
@media (max-width: 600px) {
  .crm-cloud-popup {
    width: calc(100% - 24px);
    left: 12px !important;
    right: 12px !important;
    top: 60px !important;
  }
}
`;
    document.head.appendChild(style);
  }

  function makeDraggable(popup, handle) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = popup.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = startLeft + dx;
      const newTop = startTop + dy;
      popup.style.left = newLeft + "px";
      popup.style.top = newTop + "px";
      popup.style.right = "auto";
    }

    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
  }

  function renderPopup(customerId, customerData, meta) {
    createStyles();

    const existing = document.getElementById("crm-cloud-popup");
    if (existing) {
      existing.remove();
    }

    const popup = document.createElement("div");
    popup.id = "crm-cloud-popup";
    popup.className = "crm-cloud-popup";

    const header = document.createElement("div");
    header.className = "crm-cloud-header";

    const title = document.createElement("div");
    title.className = "crm-cloud-title";

    const icon = document.createElement("div");
    icon.className = "crm-cloud-title-icon";
    icon.textContent = "📋";

    const titleText = document.createElement("div");
    titleText.textContent = customerId
      ? `客户 ${customerId}`
      : "客户维护信息";

    title.appendChild(icon);
    title.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "crm-cloud-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => popup.remove());

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "crm-cloud-body";

    const label = document.createElement("div");
    label.className = "crm-cloud-label";
    label.textContent = "📌 维护方向";

    const directionBox = document.createElement("div");
    directionBox.className = "crm-cloud-direction-box";

    const directionText = document.createElement("div");
    directionText.className = "crm-cloud-direction-text";

    if (customerData) {
      if (customerData.maintenanceDirection) {
        directionText.textContent = customerData.maintenanceDirection;
      } else {
        directionText.className = "crm-cloud-empty";
        directionText.textContent = "该客户暂无维护方向说明。";
      }
    } else {
      directionText.className = "crm-cloud-empty";
      directionText.textContent = "未找到该客户维护信息。";
    }

    directionBox.appendChild(directionText);
    body.appendChild(label);
    body.appendChild(directionBox);

    const footer = document.createElement("div");
    footer.className = "crm-cloud-footer";

    const linkBtn = document.createElement("button");
    linkBtn.className = "crm-cloud-link-btn";
    linkBtn.innerHTML =
      '<span class="crm-cloud-link-btn-icon">🔗</span><span>前往详情页</span>';

    if (customerData && customerData.url) {
      linkBtn.disabled = false;
      linkBtn.addEventListener("click", () => {
        window.open(customerData.url, "_blank", "noopener");
      });
    } else {
      linkBtn.disabled = true;
      linkBtn.style.opacity = "0.6";
      linkBtn.style.cursor = "not-allowed";
    }

    const metaDiv = document.createElement("div");
    metaDiv.className = "crm-cloud-meta";
    if (meta && (meta.version || meta.lastUpdate)) {
      metaDiv.textContent = `数据版本: v${meta.version || "-"} | 更新: ${
        meta.lastUpdate || "-"
      }`;
    } else {
      metaDiv.textContent = "数据未加载";
    }

    footer.appendChild(linkBtn);
    footer.appendChild(metaDiv);

    popup.appendChild(header);
    popup.appendChild(body);
    popup.appendChild(footer);

    document.body.appendChild(popup);

    makeDraggable(popup, header);
  }

  function renderErrorPopup(message, meta) {
    renderPopup(null, null, meta);
    const popup = document.getElementById("crm-cloud-popup");
    if (!popup) return;
    const textEl = popup.querySelector(".crm-cloud-direction-text");
    if (textEl) {
      textEl.className = "crm-cloud-empty";
      textEl.textContent = message || "数据加载失败，请稍后重试。";
    }
  }

  /*****************************************************************
   * 主流程
   *****************************************************************/

  async function main() {
    if (!isOnCrmPage()) {
      return;
    }

    const customerId = extractCustomerIdFromUrl();
    if (!customerId) {
      log("当前页面未识别到 CustomerID，脚本结束。");
      return;
    }

    log("识别到 CustomerID:", customerId);

    // 1. 先尝试使用有效缓存
    const validCache = getValidCache();
    if (validCache) {
      log("命中有效缓存，直接渲染。");
      const customer = getCustomerData(validCache.customers, customerId);
      renderPopup(customerId, customer, {
        version: validCache.version,
        lastUpdate: validCache.lastUpdate,
      });

      // 后台静默更新
      fetchDataWithFallback()
        .then((data) => {
          if (data && data.customers) {
            log("后台更新数据成功，刷新缓存。");
            setCache(data);
          }
        })
        .catch((e) => {
          warn("后台更新数据失败", e);
        });

      return;
    }

    // 2. 缓存过期或不存在：请求 CDN
    log("缓存不存在或已过期，开始从 CDN 获取数据。");
    const oldCacheRaw = getCacheRaw();
    let data = await fetchDataWithFallback();

    if (data && data.customers) {
      setCache(data);
      const customer = getCustomerData(data.customers, customerId);
      renderPopup(customerId, customer, {
        version: data.version,
        lastUpdate: data.lastUpdate,
      });
      return;
    }

    // 3. 所有 CDN 节点请求失败：尝试使用旧缓存
    warn("所有 CDN 节点请求失败，尝试使用旧缓存。");
    if (oldCacheRaw && oldCacheRaw.data && oldCacheRaw.data.customers) {
      const customer = getCustomerData(
        oldCacheRaw.data.customers,
        customerId
      );
      renderPopup(customerId, customer, {
        version: oldCacheRaw.data.version,
        lastUpdate: oldCacheRaw.data.lastUpdate,
      });
      return;
    }

    // 4. 无缓存且网络失败
    warn("无缓存且网络请求失败，显示错误提示弹窗。");
    renderErrorPopup("数据加载失败，请稍后重试。", null);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();

