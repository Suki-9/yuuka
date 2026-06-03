/* ==============================================================================
   Personal Assistant Dashboard - パーソナルアシスタント管理室 - Core Frontend JS Engine
   Secure Vanilla Javascript, Zero-Dependency, Pure DOM elements & SSE/REST
   Upgraded UI Logic: Custom Interactive Crypto Sparklines and Line Charts
   ============================================================================== */

document.addEventListener("DOMContentLoaded", () => {

  // Override native fetch to auto-inject currentBotId
  const originalFetch = window.fetch;
  window.fetch = async function (resource, options) {
    if (typeof resource === "string" && resource.startsWith("/api/") && window.currentBotId) {
      if (
        !resource.startsWith("/api/login") &&
        !resource.startsWith("/api/register") &&
        !resource.startsWith("/api/logout") &&
        !resource.startsWith("/api/bots") &&
        !resource.startsWith("/api/me")
      ) {
        const url = new URL(resource, window.location.origin);
        if (!url.searchParams.has("botId")) {
          url.searchParams.set("botId", window.currentBotId);
        }
        resource = url.pathname + url.search;

        if (options && options.body && typeof options.body === "string" && !options.body.startsWith("-----")) {
          try {
            const bodyObj = JSON.parse(options.body);
            if (!bodyObj.botId) {
              bodyObj.botId = window.currentBotId;
              options.body = JSON.stringify(bodyObj);
            }
          } catch (e) {
            // Ignore parsing errors for non-JSON bodies
          }
        }
      }
    }
    return originalFetch(resource, options);
  };

  // State management
  let activeTab = "dashboard";
  let activeUserId = "";
  let activeUserRole = "user";
  let pendingTasksCount = 0;
  let totalExpensesVal = 0;

  // Cache DOM Elements
  const loginOverlay = document.getElementById("login-overlay");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const appContainer = document.getElementById("app-container");

  // Bot Selection Overlay DOM elements
  const botSelectionOverlay = document.getElementById("bot-selection-overlay");
  const botList = document.getElementById("bot-list");
  const btnShowAddBot = document.getElementById("btn-show-add-bot");
  const btnBotLogout = document.getElementById("btn-bot-logout");
  const modalCreateBot = document.getElementById("modal-create-bot");
  const createBotForm = document.getElementById("create-bot-form");
  const btnCloseCreateBot = document.getElementById("btn-close-create-bot");
  const btnSwitchBot = document.getElementById("btn-switch-bot");
  const activeBotDisplay = document.getElementById("active-bot-display");

  // Login / Register Tabs
  const btnTabLogin = document.getElementById("btn-tab-login");
  const btnTabRegister = document.getElementById("btn-tab-register");
  const loginTabContent = document.getElementById("login-tab-content");
  const registerTabContent = document.getElementById("register-tab-content");
  const registerForm = document.getElementById("register-form");

  const btnLogout = document.getElementById("btn-logout");

  const currentTabTitle = document.getElementById("current-tab-title");
  const menuItems = document.querySelectorAll(".menu-item");
  const tabViews = document.querySelectorAll(".tab-view");

  function updateSidebarBotBranding() {
    const sidebarAppAvatar = document.getElementById("sidebar-app-avatar");
    const sidebarAppName = document.getElementById("sidebar-app-name");
    const sidebarAppId = document.getElementById("sidebar-app-id");
    
    if (!sidebarAppName || !sidebarAppId) return;

    const botName = localStorage.getItem("currentBotName") || "システムデフォルト";
    const botId = localStorage.getItem("currentBotId") || "system_default";
    const botAvatar = localStorage.getItem("currentBotAvatar") || "";

    sidebarAppName.textContent = botName;
    sidebarAppId.textContent = botId.startsWith("bot_") ? botId.substring(4) : botId;

    if (sidebarAppAvatar) {
      if (botAvatar) {
        sidebarAppAvatar.src = botAvatar;
        sidebarAppAvatar.style.display = "block";
      } else {
        sidebarAppAvatar.src = "https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png";
        sidebarAppAvatar.style.display = "block";
      }
    }
  }

  // Dashboard DOM
  const yuukaBubbleText = document.getElementById("yuuka-bubble-text");
  const statPendingTasks = document.getElementById("stat-pending-tasks");
  const statUpcomingSchedules = document.getElementById("stat-upcoming-schedules");
  const statExpensesTotal = document.getElementById("stat-expenses-total");
  const donutSegment = document.getElementById("donut-segment");
  const chartCenterPercentage = document.getElementById("chart-center-percentage");
  const dashboardCategoryLegend = document.getElementById("dashboard-category-legend");
  const dashboardUrgentList = document.getElementById("dashboard-urgent-list");
  const tasksList = document.getElementById("tasks-list");
  const schedulesList = document.getElementById("schedules-list");

  // Modal DOM
  const modalTask = document.getElementById("modal-task");
  const modalSchedule = document.getElementById("modal-schedule");
  const modalReceiptResult = document.getElementById("modal-receipt-result");
  const modalCredential = document.getElementById("modal-credential");
  const taskForm = document.getElementById("task-form");
  const credentialForm = document.getElementById("credential-form");
  const scheduleForm = document.getElementById("schedule-form");
  const receiptAiResponse = document.getElementById("receipt-ai-response");

  // Expenses Tab DOM
  const expenseMonthTotal = document.getElementById("expense-month-total");
  const expenseBudgetBar = document.getElementById("expense-budget-bar");
  const expenseBudgetPercent = document.getElementById("expense-budget-percent");
  const expenseBudgetStatus = document.getElementById("expense-budget-status");
  const receiptDropzone = document.getElementById("receipt-dropzone");
  const receiptFileInput = document.getElementById("receipt-file-input");
  const scanStatus = document.getElementById("scan-status");
  const scanStatusText = document.getElementById("scan-status-text");
  const expenseForm = document.getElementById("expense-form");
  const expensesTableBody = document.getElementById("expenses-table-body");

  // Setup Date inputs defaults
  const expDateInput = document.getElementById("exp-date");
  if (expDateInput) {
    expDateInput.value = new Date().toISOString().slice(0, 10);
  }

  // Handle Google OAuth callback notifications
  const urlParams = new URLSearchParams(window.location.search);
  const oauthStatus = urlParams.get("oauth");
  if (oauthStatus === "success") {
    const note = urlParams.get("note");
    if (note === "existing_token_used") {
      alert("🎉 Googleアカウント連携が完了しました！（既存の接続を使用します）");
    } else {
      alert("🎉 Googleアカウントとの認証連携に成功しました！");
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (oauthStatus === "error") {
    const errorMsg = urlParams.get("msg") || "未知のエラー";
    alert(`❌ Google連携認証に失敗しました:\n${errorMsg}`);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // ==========================================
  // VIEW ROUTER (HTML5 History Path-based Routing)
  // ==========================================
  function switchTab(tabId) {
    activeTab = tabId;

    // Update menu buttons active state
    menuItems.forEach(item => {
      if (item.getAttribute("data-tab") === tabId) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });

    // Update visible views
    tabViews.forEach(view => {
      if (view.id === `tab-${tabId}`) {
        view.classList.add("active");
      } else {
        view.classList.remove("active");
      }
    });

    // Update Header text
    const titles = {
      dashboard: "ダッシュボード",
      tasks: "タスク管理",
      schedules: "予定スケジュール",
      expenses: "家計管理",
      playbooks: "Playbook 設定",
      config: "システム設定情報",
      admin: "管理者パネル"
    };
    currentTabTitle.textContent = titles[tabId] || "ダッシュボード";

    // Trigger data load
    loadDataForActiveTab();
  }

  function navigateTo(path, pushState = true) {
    if (pushState) {
      window.history.pushState({}, "", path);
    }
    applyRoute(path);
  }

  function applyRoute(path) {
    const cleanPath = path.split("?")[0].split("#")[0].replace(/\/$/, "") || "/";

    if (cleanPath === "/login") {
      appContainer.classList.add("hidden");
      botSelectionOverlay.classList.remove("active");
      loginOverlay.classList.add("active");
      const botSetupTabContent = document.getElementById("bot-setup-tab-content");
      if (botSetupTabContent) botSetupTabContent.classList.remove("active");
      return;
    }

    if (cleanPath === "/bots") {
      if (!activeUserId) {
        initAppSession();
        return;
      }
      loginOverlay.classList.remove("active");
      appContainer.classList.add("hidden");
      botSelectionOverlay.classList.add("active");
      fetchBotList();
      return;
    }

    const tabMap = {
      "/dashboard": "dashboard",
      "/tasks": "tasks",
      "/schedules": "schedules",
      "/expenses": "expenses",
      "/playbooks": "playbooks",
      "/config": "config",
      "/admin": "admin"
    };

    const tabId = tabMap[cleanPath];
    if (tabId) {
      if (!activeUserId) {
        initAppSession();
        return;
      }
      const botId = localStorage.getItem("currentBotId");
      const botName = localStorage.getItem("currentBotName");
      if (!botId) {
        navigateTo("/bots", false);
        return;
      }
      window.currentBotId = botId;
      if (activeBotDisplay) {
        activeBotDisplay.textContent = botName || "ボット名";
      }
      updateSidebarBotBranding();

      loginOverlay.classList.remove("active");
      botSelectionOverlay.classList.remove("active");
      appContainer.classList.remove("hidden");

      switchTab(tabId);
      return;
    }

    if (cleanPath === "/" || cleanPath === "/index.html") {
      if (activeUserId) {
        const botId = localStorage.getItem("currentBotId");
        if (botId) {
          navigateTo("/config", false);
        } else {
          navigateTo("/bots", false);
        }
      } else {
        initAppSession();
      }
    } else {
      navigateTo("/login", false);
    }
  }

  menuItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const tabId = item.getAttribute("data-tab");
      navigateTo(`/${tabId}`);
    });
  });

  // ==========================================
  // MODALS CONTROL
  // ==========================================
  function openModal(modal) {
    modal.classList.add("active");
  }

  function closeModal(modal) {
    modal.classList.remove("active");
  }

  document.querySelectorAll(".btn-close, .btn-close-modal").forEach(btn => {
    btn.addEventListener("click", () => {
      closeModal(modalTask);
      closeModal(modalSchedule);
      closeModal(modalReceiptResult);
      closeModal(modalCredential);
      closeModal(modalCreateBot);
    });
  });

  // Open triggers
  document.getElementById("btn-new-task").addEventListener("click", () => openModal(modalTask));
  document.getElementById("btn-new-schedule").addEventListener("click", () => openModal(modalSchedule));
  document.getElementById("btn-new-credential").addEventListener("click", () => openModal(modalCredential));

  // ==========================================
  // API FETCH & CORE LOGIC
  // ==========================================

  // Execute calls based on visible view
  function loadDataForActiveTab() {
    if (activeTab === "dashboard") {
      fetchDashboardStats();
    } else if (activeTab === "tasks") {
      fetchTasksList();
    } else if (activeTab === "schedules") {
      fetchSchedulesList();
    } else if (activeTab === "expenses") {
      fetchExpensesList();
    } else if (activeTab === "playbooks") {
      fetchPlaybooksList();
    } else if (activeTab === "config") {
      fetchConfigSettings();
    } else if (activeTab === "admin") {
      fetchAdminData();
    }
  }

  // Tab switching inside login Overlay
  if (btnTabLogin && btnTabRegister) {
    btnTabLogin.addEventListener("click", () => {
      btnTabLogin.classList.add("active");
      btnTabRegister.classList.remove("active");
      loginTabContent.classList.add("active");
      registerTabContent.classList.remove("active");
      loginError.textContent = "";
    });

    btnTabRegister.addEventListener("click", () => {
      btnTabLogin.classList.remove("active");
      btnTabRegister.classList.add("active");
      loginTabContent.classList.remove("active");
      registerTabContent.classList.add("active");
      loginError.textContent = "";
    });
  }

  // Bot selection functions
  async function fetchBotList() {
    try {
      const res = await originalFetch("/api/bots");
      const data = await res.json();
      if (data.success) {
        renderBotList(data.bots);
      } else {
        alert("Bot一覧の取得に失敗しました: " + data.message);
      }
    } catch (err) {
      console.error(err);
      alert("Bot一覧の取得中にエラーが発生しました。");
    }
  }

  function renderBotList(bots) {
    botList.innerHTML = "";
    bots.forEach(bot => {
      const item = document.createElement("div");
      item.className = "bot-item-card";
      if (bot.id.startsWith("bot_default_") || bot.id === "system_default") {
        item.classList.add("default-bot");
      }

      const isCustomToken = !!bot.discord_token_encrypted;
      const statusText = isCustomToken ? "独自Bot起動中" : "デフォルト共有";
      const accentColor = isCustomToken ? "#10b981" : "#3b82f6";

      // アバター部分
      const avatarDiv = document.createElement("div");
      avatarDiv.className = "bot-avatar";
      if (bot.discord_avatar_url) {
        const img = document.createElement("img");
        img.src = bot.discord_avatar_url;
        img.alt = bot.discord_username || bot.name;
        img.onerror = () => {
          img.remove();
          avatarDiv.innerHTML = `<span class="material-symbols-outlined" style="font-size: 22px; color: ${accentColor};">robot_2</span>`;
        };
        avatarDiv.appendChild(img);
      } else {
        avatarDiv.innerHTML = `<span class="material-symbols-outlined" style="font-size: 22px; color: ${accentColor};">robot_2</span>`;
      }

      // Bot情報部分
      const infoDiv = document.createElement("div");
      infoDiv.className = "bot-info";
      const displayName = bot.discord_username || bot.name;
      infoDiv.innerHTML = `
        <div class="bot-name" title="${displayName}">${displayName}</div>
        <div class="bot-status">${statusText}</div>
      `;

      // アクションボタン群
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "bot-item-actions";

      // Discord同期ボタン
      const syncBtn = document.createElement("button");
      syncBtn.className = "btn-sync-discord";
      syncBtn.title = "Discordから名前・アイコンを同期";
      syncBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 15px;">sync</span>`;
      syncBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const icon = syncBtn.querySelector("span");
        if (icon) icon.style.animation = "spin 0.8s linear infinite";
        syncBtn.style.pointerEvents = "none";
        try {
          const res = await originalFetch("/api/bots/sync-discord", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ botId: bot.id })
          });
          const data = await res.json();
          if (data.success) {
            // UIをその場で更新
            bot.discord_username = data.discord_username;
            bot.discord_avatar_url = data.discord_avatar_url;
            if (data.discord_avatar_url) {
              avatarDiv.innerHTML = "";
              const img = document.createElement("img");
              img.src = data.discord_avatar_url;
              img.alt = data.discord_username || bot.name;
              img.onerror = () => {
                img.remove();
                avatarDiv.innerHTML = `<span class="material-symbols-outlined" style="font-size: 22px; color: ${accentColor};">robot_2</span>`;
              };
              avatarDiv.appendChild(img);
            }
            infoDiv.querySelector(".bot-name").textContent = data.discord_username || bot.name;
          } else {
            alert("同期に失敗しました: " + data.message);
          }
        } catch (err) {
          alert("同期中にエラーが発生しました。");
        } finally {
          if (icon) icon.style.animation = "";
          syncBtn.style.pointerEvents = "";
        }
      });
      actionsDiv.appendChild(syncBtn);

      // 編集ボタン（デフォルトBot以外、所有者のみ）
      if (!bot.id.startsWith("bot_default_") && bot.id !== "system_default") {
        const editBtn = document.createElement("button");
        editBtn.className = "btn-sync-discord";
        editBtn.title = "名前・アイコンを編集";
        editBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 15px;">edit</span>`;
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const profileModal = document.getElementById("modal-edit-bot-profile");
          document.getElementById("edit-bot-profile-id").value = bot.id;
          document.getElementById("edit-bot-profile-name").value = bot.discord_username || bot.name;
          document.getElementById("edit-bot-profile-avatar").value = bot.discord_avatar_url || "";
          if (profileModal) profileModal.classList.add("active");
        });
        actionsDiv.appendChild(editBtn);
      }

      // 削除ボタン（デフォルトBot以外）
      if (!bot.id.startsWith("bot_default_") && bot.id !== "system_default") {
        const delBtn = document.createElement("button");
        delBtn.className = "btn-delete-bot-inline";
        delBtn.title = "Botを削除";
        delBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 15px;">delete</span>`;
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (confirm(`本当にBot「${bot.name}」を削除しますか？\n紐づく経費やタスクデータも全て削除されます。`)) {
            try {
              const res = await originalFetch("/api/bots", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ botId: bot.id })
              });
              const resData = await res.json();
              if (resData.success) {
                fetchBotList();
              } else {
                alert("削除に失敗しました: " + resData.message);
              }
            } catch (err) {
              alert("削除中にエラーが発生しました。");
            }
          }
        });
        actionsDiv.appendChild(delBtn);
      }

      item.appendChild(avatarDiv);
      item.appendChild(infoDiv);
      item.appendChild(actionsDiv);

      item.addEventListener("click", () => {
        selectBot(bot);
      });

      botList.appendChild(item);
    });
  }

  function selectBot(bot) {
    window.currentBotId = bot.id;
    localStorage.setItem("currentBotId", bot.id);
    localStorage.setItem("currentBotName", bot.discord_username || bot.name);
    localStorage.setItem("currentBotAvatar", bot.discord_avatar_url || "");
    if (activeBotDisplay) {
      activeBotDisplay.textContent = bot.discord_username || bot.name;
    }
    updateSidebarBotBranding();

    navigateTo("/config");
  }

  // Bot Profile Edit Modal
  const modalEditBotProfile = document.getElementById("modal-edit-bot-profile");
  const editBotProfileForm = document.getElementById("edit-bot-profile-form");
  const btnCloseEditBotProfile = document.getElementById("btn-close-edit-bot-profile");

  if (btnCloseEditBotProfile && modalEditBotProfile) {
    btnCloseEditBotProfile.addEventListener("click", () => modalEditBotProfile.classList.remove("active"));
  }

  if (editBotProfileForm) {
    editBotProfileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const botId = document.getElementById("edit-bot-profile-id").value;
      const name = document.getElementById("edit-bot-profile-name").value.trim();
      const avatarUrl = document.getElementById("edit-bot-profile-avatar").value.trim();

      try {
        const res = await originalFetch("/api/bots/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botId, name, avatarUrl: avatarUrl || null })
        });
        const data = await res.json();
        if (data.success) {
          modalEditBotProfile.classList.remove("active");
          fetchBotList();
        } else {
          alert("更新に失敗しました: " + data.message);
        }
      } catch (err) {
        alert("通信エラーが発生しました。");
      }
    });
  }

  // Switch Bot handler
  if (btnSwitchBot) {
    btnSwitchBot.addEventListener("click", () => {
      navigateTo("/bots");
    });
  }
  const sidebarBtnBackBots = document.getElementById("sidebar-btn-back-bots");
  if (sidebarBtnBackBots) {
    sidebarBtnBackBots.addEventListener("click", () => {
      navigateTo("/bots");
    });
  }

  if (btnShowAddBot) {
    btnShowAddBot.addEventListener("click", () => {
      openModal(modalCreateBot);
    });
  }

  if (createBotForm) {
    createBotForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("new-bot-name").value.trim();
      const persona = document.getElementById("new-bot-persona").value.trim();

      try {
        const res = await originalFetch("/api/bots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, persona })
        });
        const data = await res.json();
        if (data.success) {
          closeModal(modalCreateBot);
          createBotForm.reset();
          fetchBotList();
        } else {
          alert("Bot作成に失敗しました: " + data.message);
        }
      } catch (err) {
        alert("Bot作成中にエラーが発生しました。");
      }
    });
  }

  if (btnBotLogout) {
    btnBotLogout.addEventListener("click", async () => {
      try {
        await originalFetch("/api/logout", { method: "POST" });
      } catch (e) { }
      localStorage.removeItem("currentBotId");
      localStorage.removeItem("currentBotName");
      window.currentBotId = null;
      activeUserId = "";
      navigateTo("/login");
    });
  }

  async function checkSetupStatus() {
    try {
      const res = await originalFetch("/api/setup/status");
      const data = await res.json();
      
      const loginTabContent = document.getElementById("login-tab-content");
      const registerTabContent = document.getElementById("register-tab-content");
      const setupTabContent = document.getElementById("setup-tab-content");
      const botSetupTabContent = document.getElementById("bot-setup-tab-content");
      const loginTabs = document.querySelector(".login-tabs");

      if (data.needSetup) {
        if (loginTabs) loginTabs.style.display = "none";
        if (loginTabContent) loginTabContent.classList.remove("active");
        if (registerTabContent) registerTabContent.classList.remove("active");
        if (botSetupTabContent) botSetupTabContent.classList.remove("active");
        if (setupTabContent) setupTabContent.classList.add("active");
        return true;
      } else {
        if (loginTabs) loginTabs.style.display = "";
        if (setupTabContent) setupTabContent.classList.remove("active");
        return false;
      }
    } catch (err) {
      console.error("Failed to check setup status:", err);
      return false;
    }
  }

  function showDefaultBotSetupScreen() {
    loginOverlay.classList.add("active");
    botSelectionOverlay.classList.remove("active");
    appContainer.classList.add("hidden");

    const loginTabs = document.querySelector(".login-tabs");
    if (loginTabs) loginTabs.style.display = "none";

    const loginTabContent = document.getElementById("login-tab-content");
    const registerTabContent = document.getElementById("register-tab-content");
    const setupTabContent = document.getElementById("setup-tab-content");
    const botSetupTabContent = document.getElementById("bot-setup-tab-content");

    if (loginTabContent) loginTabContent.classList.remove("active");
    if (registerTabContent) registerTabContent.classList.remove("active");
    if (setupTabContent) setupTabContent.classList.remove("active");
    if (botSetupTabContent) botSetupTabContent.classList.add("active");
  }

  // App Session Initialization
  async function initAppSession() {
    try {
      const res = await originalFetch("/api/me");
      const data = await res.json();
      if (data.success) {
        activeUserId = data.user.discordId;
        activeUserRole = data.user.role || "user";
        document.getElementById("current-user-display").textContent = `${data.user.username} (${activeUserId})`;

        // Admin メニューの表示/非表示制御
        const adminMenuItem = document.getElementById("menu-item-admin");
        if (adminMenuItem) {
          adminMenuItem.style.display = activeUserRole === "admin" ? "" : "none";
        }

        // 管理者の場合、デフォルトBotが設定されているか確認する
        if (activeUserRole === "admin") {
          try {
            const botsRes = await originalFetch("/api/bots");
            const botsData = await botsRes.json();
            const systemDefaultBot = botsData.success && botsData.bots.find(b => b.id === "system_default");
            if (!systemDefaultBot || !systemDefaultBot.discord_token_encrypted) {
              showDefaultBotSetupScreen();
              return;
            }
          } catch (err) {
            console.error("Default bot check error:", err);
          }
        }

        // If already on a specific deep-link path, navigate there directly
        const currentPath = window.location.pathname;
        if (currentPath !== "/" && currentPath !== "/index.html" && currentPath !== "/login") {
          applyRoute(currentPath);
        } else {
          // Root or login page: route to bot selection or main app
          const botId = localStorage.getItem("currentBotId") || "system_default";
          navigateTo(botId ? "/config" : "/bots", false);
        }
      } else {
        activeUserId = "";
        const needSetup = await checkSetupStatus();
        if (!needSetup) {
          const btnTabLogin = document.getElementById("btn-tab-login");
          const loginTabContent = document.getElementById("login-tab-content");
          if (btnTabLogin) btnTabLogin.classList.add("active");
          if (loginTabContent) loginTabContent.classList.add("active");
        }
        navigateTo("/login", false);
      }
    } catch (err) {
      activeUserId = "";
      await checkSetupStatus();
      navigateTo("/login", false);
    }
  }

  // A. AUTHENTICATION & LOGIN FLOW
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    const discordId = document.getElementById("login-discord-id").value.trim();
    const password = document.getElementById("login-password").value;

    try {
      const res = await originalFetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId, password })
      });
      const data = await res.json();

      if (data.success) {
        await initAppSession();
      } else {
        loginError.textContent = data.message;
      }
    } catch (err) {
      loginError.textContent = "サーバー接続に失敗しました。";
    }
  });

  // INITIAL SETUP FLOW (Step 1: Admin Register)
  const setupForm = document.getElementById("setup-form");
  if (setupForm) {
    setupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError.textContent = "";
      const discordId = document.getElementById("setup-discord-id").value.trim();
      const username = document.getElementById("setup-username").value.trim();
      const password = document.getElementById("setup-password").value;

      try {
        const res = await originalFetch("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ discordId, username, password })
        });
        const data = await res.json();

        if (data.success) {
          alert("管理者アカウントの登録が完了しました。続いてデフォルトBotを設定してください。");
          await initAppSession();
        } else {
          loginError.textContent = data.message;
        }
      } catch (err) {
        loginError.textContent = "サーバー接続に失敗しました。";
      }
    });
  }

  // INITIAL SETUP FLOW (Step 2: Default Bot Token Setup)
  const botSetupForm = document.getElementById("bot-setup-form");
  if (botSetupForm) {
    botSetupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError.textContent = "";
      const token = document.getElementById("bot-setup-token").value.trim();

      try {
        const res = await originalFetch("/api/admin/default-bot/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const data = await res.json();

        if (data.success) {
          alert("デフォルトBotのセットアップが完了しました！");
          window.currentBotId = "system_default";
          localStorage.setItem("currentBotId", "system_default");
          localStorage.setItem("currentBotName", "システムデフォルト");
          localStorage.setItem("currentBotAvatar", "");
          updateSidebarBotBranding();
          
          loginOverlay.classList.remove("active");
          navigateTo("/dashboard");
        } else {
          loginError.textContent = data.message;
        }
      } catch (err) {
        loginError.textContent = "サーバー接続に失敗しました。";
      }
    });
  }

  // ACCOUNT REGISTRATION FLOW
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    const discordId = document.getElementById("reg-discord-id").value.trim();
    const username = document.getElementById("reg-username").value.trim();
    const password = document.getElementById("reg-password").value;
    const inviteCode = document.getElementById("reg-invite-code").value.trim();

    try {
      const res = await originalFetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId, username, password, inviteCode })
      });
      const data = await res.json();

      if (data.success) {
        alert("アカウントが作成されました！ログインを行ってください。");
        btnTabLogin.click();
        document.getElementById("login-discord-id").value = discordId;
      } else {
        loginError.textContent = data.message;
      }
    } catch (err) {
      loginError.textContent = "サーバー接続に失敗しました。";
    }
  });

  // B. LOGOUT FLOW
  btnLogout.addEventListener("click", async () => {
    try {
      await originalFetch("/api/logout", { method: "POST" });
    } catch (e) { }

    localStorage.removeItem("currentBotId");
    localStorage.removeItem("currentBotName");
    window.currentBotId = null;
    activeUserId = "";
    navigateTo("/login");
    loginError.textContent = "ログアウトしました。";
  });

  // D. DASHBOARD STATS POLL
  async function fetchDashboardStats() {
    try {
      const statusRes = await fetch("/api/status");
      const statusData = await statusRes.json();

      const expenseRes = await fetch("/api/expenses");
      const expenseData = await expenseRes.json();

      if (statusData.success && expenseData.success) {
        pendingTasksCount = statusData.stats.pendingTasks;
        totalExpensesVal = expenseData.total;

        // Populate Stats DOM
        statPendingTasks.textContent = pendingTasksCount;
        statUpcomingSchedules.textContent = statusData.stats.schedules;
        statExpensesTotal.textContent = `¥${totalExpensesVal.toLocaleString()}`;

        // Speech bubble update
        updateYuukaSpeechBubble();

        // Render Priority Mini Bar Chart inside Card 1 (Tasks)
        const priorityChart = document.getElementById("tasks-priority-bar-chart");
        if (priorityChart) {
          priorityChart.replaceChildren();
          const priorities = statusData.stats.pendingPriorities || { 0: 0, 1: 0, 2: 0 };
          const maxPrioCount = Math.max(priorities[0], priorities[1], priorities[2], 1);

          const colors = ["#4f545c", "#fbbf24", "#da373c"]; // Low: Muted Grey, Medium: Warning Yellow, High: Discord Red
          const labels = ["低", "中", "高"];

          [0, 1, 2].forEach(p => {
            const barContainer = document.createElement("div");
            barContainer.style.display = "flex";
            barContainer.style.flexDirection = "column";
            barContainer.style.alignItems = "center";
            barContainer.style.flex = "1";
            barContainer.style.height = "100%";
            barContainer.style.justifyContent = "flex-end";
            barContainer.title = `${labels[p]}優先度: ${priorities[p]}件`;

            const bar = document.createElement("div");
            const pct = (priorities[p] / maxPrioCount) * 100;
            bar.style.height = `${Math.max(pct, 10)}%`;
            bar.style.width = "100%";
            bar.style.backgroundColor = colors[p];
            bar.style.borderRadius = "var(--radius)";
            bar.style.transition = "height 0.3s ease";

            const countText = document.createElement("span");
            countText.style.fontSize = "0.55rem";
            countText.style.fontFamily = "var(--font-family-mono)";
            countText.style.color = "var(--color-zinc-muted)";
            countText.style.marginBottom = "2px";
            countText.textContent = priorities[p];

            barContainer.appendChild(countText);
            barContainer.appendChild(bar);
            priorityChart.appendChild(barContainer);
          });
        }

        // Render Schedules Sparkline (real line over next 5 days)
        const schedulesPath = document.getElementById("schedules-sparkline-path");
        if (schedulesPath) {
          const trend = statusData.stats.scheduleTrend || [0, 0, 0, 0, 0];
          const maxVal = Math.max(...trend, 2);

          const points = trend.map((val, idx) => {
            const x = idx * 25;
            const y = 19 - (val / maxVal) * 18;
            return `${x},${y}`;
          });
          const pathStr = `M ${points.map((p, idx) => `${idx === 0 ? "" : "L "} ${p}`).join(" ")}`;
          schedulesPath.setAttribute("d", pathStr);
        }

        // Render Expenses Sparkline (real line over past 5 days)
        const expensesPath = document.getElementById("expenses-sparkline-path");
        if (expensesPath) {
          const trend = statusData.stats.expenseTrend || [0, 0, 0, 0, 0];
          const maxVal = Math.max(...trend, 5000);

          const points = trend.map((val, idx) => {
            const x = idx * 25;
            const y = 19 - (val / maxVal) * 18;
            return `${x},${y}`;
          });
          const pathStr = `M ${points.map((p, idx) => `${idx === 0 ? "" : "L "} ${p}`).join(" ")}`;
          expensesPath.setAttribute("d", pathStr);
        }

        // Render Donut Chart
        renderDonutChart(expenseData.breakdown, expenseData.total);

        // Fetch Urgent items (pending tasks & today's schedules combined)
        renderUrgentDashboardList(statusData.stats.pendingTasks);

        // Extra Crypto Ticker Analytics
        const maxExp = expenseData.expenses && expenseData.expenses.length > 0
          ? Math.max(...expenseData.expenses.map(e => e.amount))
          : 0;
        document.getElementById("dashboard-highest-expense").textContent = `¥${maxExp.toLocaleString()}`;

        const maxCat = expenseData.breakdown && expenseData.breakdown.length > 0
          ? expenseData.breakdown[0].category
          : "なし";
        document.getElementById("dashboard-highest-category").textContent = maxCat;

        const avg = expenseData.expenses && expenseData.expenses.length > 0
          ? Math.round(expenseData.total / 30)
          : 0;
        document.getElementById("dashboard-average-expense").textContent = `¥${avg.toLocaleString()}`;

        // Render interactive Price Trend Line Chart
        renderPriceTrendChart(expenseData.expenses);
      }
    } catch (err) {
      console.error("ダッシュボード情報の更新エラー:", err);
      yuukaBubbleText.textContent = "ダッシュボード情報の取得中にエラーが発生しました。サーバーの接続状況を確認してください。";
    }
  }

  function updateYuukaSpeechBubble() {
    let text = "";
    if (totalExpensesVal > 30000) {
      text = `今月の支出が ¥${totalExpensesVal.toLocaleString()} に達しています。予算を確認してみましょう。`;
    } else if (pendingTasksCount > 5) {
      text = `未完了タスクが ${pendingTasksCount} 件あります。優先度の高いものから片付けていきましょう。`;
    } else {
      text = "お疲れ様です。タスク・予定・家計の管理をサポートします。何かあればDiscordでお声がけください。";
    }
    yuukaBubbleText.textContent = text;
  }

  function renderDonutChart(breakdown, total) {
    dashboardCategoryLegend.replaceChildren();

    if (!breakdown || breakdown.length === 0 || total === 0) {
      donutSegment.setAttribute("stroke-dasharray", "0 251.2");
      chartCenterPercentage.textContent = "0%";

      const empty = document.createElement("div");
      empty.className = "legend-item";
      empty.textContent = "今月のデータはありません。";
      dashboardCategoryLegend.appendChild(empty);
      return;
    }

    const entertainment = breakdown.find(c => c.category === "娯楽");
    const entPct = entertainment ? Math.round((entertainment.total / total) * 100) : 0;

    const strokeDash = (entPct * 251.2) / 100;
    donutSegment.setAttribute("stroke-dasharray", `${strokeDash} 251.2`);
    chartCenterPercentage.textContent = `${entPct}%`;

    const colors = {
      食費: "#5865F2", // Discord Blurple
      日用品: "#248046", // Success green
      交通費: "#fbbf24", // Warning yellow
      娯楽: "#f472b6", // Pink
      その他: "#4f545c" // Grey
    };

    breakdown.slice(0, 4).forEach(cat => {
      const pct = Math.round((cat.total / total) * 100);
      const dotColor = colors[cat.category] || "#a78bfa";

      const item = document.createElement("div");
      item.className = "legend-item";

      const colorBox = document.createElement("span");
      colorBox.className = "legend-color";
      colorBox.style.backgroundColor = dotColor;

      const label = document.createElement("span");
      label.textContent = `${cat.category}: ¥${cat.total.toLocaleString()} (${pct}%)`;

      item.appendChild(colorBox);
      item.appendChild(label);
      dashboardCategoryLegend.appendChild(item);
    });
  }

  function renderPriceTrendChart(expenses) {
    const trendLinePath = document.getElementById("trend-line-path");
    const trendAreaPath = document.getElementById("trend-area-path");
    const trendChartSvg = document.getElementById("dashboard-trend-chart");

    const circles = trendChartSvg.querySelectorAll("circle");
    circles.forEach(c => c.remove());

    const dateLabels = [];
    const dateStrings = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateStrings.push(d.toISOString().slice(0, 10));
      dateLabels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }

    const xAxisContainer = trendChartSvg.nextElementSibling;
    xAxisContainer.replaceChildren();
    dateLabels.forEach((label, idx) => {
      const span = document.createElement("span");
      span.textContent = idx === 0 ? "5日前" : idx === 4 ? "昨日" : idx === 5 ? "今日" : label;
      xAxisContainer.appendChild(span);
    });

    const dailyTotals = dateStrings.map(date => {
      if (!expenses) return 0;
      return expenses
        .filter(e => e.date === date)
        .reduce((sum, e) => sum + e.amount, 0);
    });

    const maxVal = Math.max(...dailyTotals, 10000);

    const points = dailyTotals.map((val, idx) => {
      const x = idx * 80;
      const y = 130 - (val / maxVal) * 100;
      return { x, y, amount: val };
    });

    const linePathStr = points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" ");
    trendLinePath.setAttribute("d", linePathStr);

    const areaPathStr = `M 0,130 ${points.map(p => `L ${p.x},${p.y}`).join(" ")} L 400,130 Z`;
    trendAreaPath.setAttribute("d", areaPathStr);

    points.forEach(p => {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", p.x);
      circle.setAttribute("cy", p.y);
      circle.setAttribute("r", "4.5");
      circle.setAttribute("fill", "var(--color-primary)");
      circle.setAttribute("stroke", "var(--bg-primary)");
      circle.setAttribute("stroke-width", "1.5");
      circle.style.cursor = "pointer";
      circle.style.transition = "r 0.15s ease, fill 0.15s ease";

      circle.addEventListener("mouseenter", () => {
        circle.setAttribute("r", "7.5");
        circle.setAttribute("fill", "var(--color-white)");
        yuukaBubbleText.textContent = `${p.x === 400 ? "今日" : p.x === 320 ? "昨日" : "この日"}の出費額は ¥${p.amount.toLocaleString()} です。`;
      });

      circle.addEventListener("mouseleave", () => {
        circle.setAttribute("r", "4.5");
        circle.setAttribute("fill", "var(--discord-blurple)");
        updateYuukaSpeechBubble();
      });

      trendChartSvg.appendChild(circle);
    });
  }

  async function renderUrgentDashboardList(pendingCount) {
    dashboardUrgentList.replaceChildren();

    try {
      const resSched = await fetch("/api/schedules?days=1");
      const dataSched = await resSched.json();

      const resTasks = await fetch("/api/tasks?status=pending");
      const dataTasks = await resTasks.json();

      let count = 0;

      if (dataSched.success && dataSched.schedules.length > 0) {
        dataSched.schedules.slice(0, 2).forEach(sched => {
          const item = document.createElement("div");
          item.className = "urgent-item";

          const iconSpan = document.createElement("span");
          iconSpan.className = "material-symbols-outlined icon-small";
          iconSpan.style.marginRight = "6px";
          iconSpan.textContent = "calendar_today";

          const title = document.createElement("span");
          title.textContent = ` [今日の予定] ${sched.title}`;
          title.style.fontWeight = "bold";

          const badge = document.createElement("span");
          badge.className = "urgent-badge badge-urgent";
          badge.textContent = sched.start_at.slice(11, 16);

          item.appendChild(iconSpan);
          item.appendChild(title);
          item.appendChild(badge);
          dashboardUrgentList.appendChild(item);
          count++;
        });
      }

      if (dataTasks.success && dataTasks.tasks.length > 0) {
        dataTasks.tasks.slice(0, 3).forEach(task => {
          const item = document.createElement("div");
          item.className = "urgent-item";

          const iconSpan = document.createElement("span");
          iconSpan.className = "material-symbols-outlined icon-small";
          iconSpan.style.marginRight = "6px";
          iconSpan.textContent = "checklist";

          const title = document.createElement("span");
          title.textContent = ` [未消化タスク] ${task.title}`;

          const badge = document.createElement("span");
          badge.className = "urgent-badge badge-normal";
          badge.textContent = task.priority === 2 ? "優先: 高" : "優先: 普通";

          item.appendChild(iconSpan);
          item.appendChild(title);
          item.appendChild(badge);
          dashboardUrgentList.appendChild(item);
          count++;
        });
      }

      if (count === 0) {
        const item = document.createElement("div");
        item.className = "urgent-item";
        item.textContent = "今日の急ぎのタスクや予定はありません！素晴らしい計画性ですね！";
        dashboardUrgentList.appendChild(item);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // E. TASKS VIEW LOGIC (Fetch & CRUD)
  async function fetchTasksList(filter = "all") {
    tasksList.replaceChildren();

    try {
      const res = await fetch(`/api/tasks?status=${filter}`);
      const data = await res.json();

      if (data.success && data.tasks.length > 0) {
        data.tasks.forEach(task => {
          const card = document.createElement("div");
          card.className = `card-item glass hover-lift ${task.status === "done" ? "done" : ""}`;

          const left = document.createElement("div");
          left.className = "card-content-left";

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "checkbox-custom";
          checkbox.checked = task.status === "done";
          checkbox.addEventListener("change", () => toggleTaskCompletion(task.id, checkbox.checked));

          const text = document.createElement("div");
          text.className = "card-text";

          const title = document.createElement("div");
          title.className = "card-title";
          title.textContent = task.title;

          const desc = document.createElement("div");
          desc.className = "card-desc";
          desc.textContent = task.description || "説明なし";

          const meta = document.createElement("div");
          meta.className = "card-meta-row";

          if (task.due_date) {
            const due = document.createElement("span");
            due.className = "meta-item";

            const dueIcon = document.createElement("span");
            dueIcon.className = "material-symbols-outlined meta-icon";
            dueIcon.textContent = "calendar_today";

            const dueText = document.createTextNode(` 期限: ${task.due_date}`);

            due.appendChild(dueIcon);
            due.appendChild(dueText);
            meta.appendChild(due);
          }

          const pri = document.createElement("span");
          pri.className = "meta-item";

          const priIcon = document.createElement("span");
          priIcon.className = "material-symbols-outlined meta-icon";
          priIcon.textContent = "priority_high";

          const priorityLabels = ["低", "中", "高"];
          const priText = document.createTextNode(` 優先度: ${priorityLabels[task.priority] || "低"}`);

          pri.appendChild(priIcon);
          pri.appendChild(priText);
          meta.appendChild(pri);

          text.appendChild(title);
          text.appendChild(desc);
          text.appendChild(meta);

          left.appendChild(checkbox);
          left.appendChild(text);

          const right = document.createElement("div");
          right.className = "card-actions-right";

          const btnTrash = document.createElement("button");
          btnTrash.className = "btn-trash";

          const trashIcon = document.createElement("span");
          trashIcon.className = "material-symbols-outlined";
          trashIcon.textContent = "delete";
          btnTrash.appendChild(trashIcon);

          btnTrash.addEventListener("click", () => handleDeleteTask(task.id));

          right.appendChild(btnTrash);

          card.appendChild(left);
          card.appendChild(right);
          tasksList.appendChild(card);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "glass";
        empty.textContent = "登録されているタスクがありません。";
        tasksList.appendChild(empty);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Filter Tasks
  document.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll("[data-filter]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const f = btn.getAttribute("data-filter");
      fetchTasksList(f);
    });
  });

  taskForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("task-title").value.trim();
    const description = document.getElementById("task-description").value.trim();
    const dueDate = document.getElementById("task-due").value;
    const priority = parseInt(document.getElementById("task-priority").value, 10);

    try {
      const res = await fetch("/api/tasks/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, dueDate, priority })
      });
      const data = await res.json();
      if (data.success) {
        closeModal(modalTask);
        taskForm.reset();
        fetchTasksList();
      }
    } catch (e) {
      console.error(e);
    }
  });

  async function toggleTaskCompletion(id, isChecked) {
    try {
      await fetch("/api/tasks/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const activeFilter = document.querySelector("[data-filter].active").getAttribute("data-filter");
      fetchTasksList(activeFilter);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleDeleteTask(id) {
    if (!confirm("本当にこのタスクを削除しますか？")) return;
    try {
      await fetch("/api/tasks/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const activeFilter = document.querySelector("[data-filter].active").getAttribute("data-filter");
      fetchTasksList(activeFilter);
    } catch (e) {
      console.error(e);
    }
  }

  // F. SCHEDULES VIEW LOGIC (Fetch & CRUD)
  async function fetchSchedulesList(days = 7) {
    schedulesList.replaceChildren();

    try {
      const res = await fetch(`/api/schedules?days=${days}`);
      const data = await res.json();

      if (data.success && data.schedules.length > 0) {
        data.schedules.forEach(sched => {
          const card = document.createElement("div");
          card.className = "card-item glass hover-lift";

          const left = document.createElement("div");
          left.className = "card-content-left";

          const icon = document.createElement("span");
          icon.className = "material-symbols-outlined list-card-icon";
          icon.style.fontSize = "1.8rem";
          icon.textContent = "event";

          const text = document.createElement("div");
          text.className = "card-text";

          const title = document.createElement("div");
          title.className = "card-title";
          title.textContent = sched.title;

          const desc = document.createElement("div");
          desc.className = "card-desc";
          desc.textContent = sched.description || "説明なし";

          const meta = document.createElement("div");
          meta.className = "card-meta-row";

          const time = document.createElement("span");
          time.className = "meta-item";

          const timeIcon = document.createElement("span");
          timeIcon.className = "material-symbols-outlined meta-icon";
          timeIcon.textContent = "schedule";

          const startClean = sched.start_at.slice(0, 16);
          const endClean = sched.end_at ? ` 〜 ${sched.end_at.slice(11, 16)}` : "";
          const timeText = document.createTextNode(` ${startClean}${endClean}`);

          time.appendChild(timeIcon);
          time.appendChild(timeText);
          meta.appendChild(time);

          if (sched.google_calendar_id) {
            const cal = document.createElement("span");
            cal.className = "meta-item";

            const calIcon = document.createElement("span");
            calIcon.className = "material-symbols-outlined meta-icon";
            calIcon.textContent = "sync";

            const calText = document.createTextNode(" Google同期済み");

            cal.appendChild(calIcon);
            cal.appendChild(calText);
            meta.appendChild(cal);
          }

          text.appendChild(title);
          text.appendChild(desc);
          text.appendChild(meta);

          left.appendChild(icon);
          left.appendChild(text);

          const right = document.createElement("div");
          right.className = "card-actions-right";

          const btnTrash = document.createElement("button");
          btnTrash.className = "btn-trash";

          const trashIcon = document.createElement("span");
          trashIcon.className = "material-symbols-outlined";
          trashIcon.textContent = "delete";
          btnTrash.appendChild(trashIcon);

          btnTrash.addEventListener("click", () => handleDeleteSchedule(sched.id));

          right.appendChild(btnTrash);

          card.appendChild(left);
          card.appendChild(right);
          schedulesList.appendChild(card);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "glass";
        empty.textContent = "予定が登録されていません。";
        schedulesList.appendChild(empty);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Filter Schedules by Period
  document.querySelectorAll("[data-days]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-days]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const d = parseInt(btn.getAttribute("data-days"), 10);
      fetchSchedulesList(d);
    });
  });

  scheduleForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("sched-title").value.trim();
    const description = document.getElementById("sched-description").value.trim();
    const startAt = document.getElementById("sched-start").value.replace("T", " ") + ":00";
    const endInput = document.getElementById("sched-end").value;
    const endAt = endInput ? endInput.replace("T", " ") + ":00" : undefined;
    const remindBeforeMinutes = parseInt(document.getElementById("sched-remind").value, 10);

    try {
      const res = await fetch("/api/schedules/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, startAt, endAt, remindBeforeMinutes })
      });
      const data = await res.json();
      if (data.success) {
        closeModal(modalSchedule);
        scheduleForm.reset();
        fetchSchedulesList();
      }
    } catch (e) {
      console.error(e);
    }
  });

  async function handleDeleteSchedule(id) {
    if (!confirm("本当にこの予定を削除しますか？ Googleカレンダー側からも削除されます。")) return;
    try {
      await fetch("/api/schedules/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const activeDays = parseInt(document.querySelector("[data-days].active").getAttribute("data-days"), 10);
      fetchSchedulesList(activeDays);
    } catch (e) {
      console.error(e);
    }
  }

  // G. EXPENSES VIEW LOGIC (Fetch & Receipt AI Scanning & Manual Add)
  async function fetchExpensesList() {
    expensesTableBody.replaceChildren();

    try {
      const res = await fetch("/api/expenses");
      const data = await res.json();

      if (data.success) {
        // Month stats
        expenseMonthTotal.textContent = `¥${data.total.toLocaleString()}`;

        // Progress bar calculation
        const percent = Math.min((data.total / 50000) * 100, 100);
        expenseBudgetBar.style.width = `${percent}%`;
        expenseBudgetPercent.textContent = `${Math.round(percent)}%`;

        if (percent > 90) {
          expenseBudgetBar.style.backgroundColor = "var(--color-red)";
          expenseBudgetStatus.textContent = "警告：予算上限に近づいています！無駄遣いをやめましょう。";
        } else if (percent > 60) {
          expenseBudgetBar.style.backgroundColor = "#fbbf24"; // warning orange
          expenseBudgetStatus.textContent = "注意：中程度の支出状況です。計画的な利用を。";
        } else {
          expenseBudgetBar.style.backgroundColor = "var(--discord-blurple)";
          expenseBudgetStatus.textContent = "健全：非常に計画的な支出コントロールです！";
        }

        // Render Ledger table
        if (data.expenses && data.expenses.length > 0) {
          data.expenses.forEach(exp => {
            const tr = document.createElement("tr");

            const tdDate = document.createElement("td");
            tdDate.textContent = exp.time ? `${exp.date} ${exp.time.substring(0, 5)}` : exp.date;

            const tdCat = document.createElement("td");
            tdCat.textContent = exp.category;

            const tdDesc = document.createElement("td");
            tdDesc.textContent = exp.description || "説明なし";

            const tdSource = document.createElement("td");
            tdSource.style.fontSize = "0.75rem";
            tdSource.style.fontFamily = "var(--font-family-mono)";

            const sourceIcon = document.createElement("span");
            sourceIcon.className = "material-symbols-outlined source-icon";
            sourceIcon.textContent = exp.source === "receipt" ? "photo_camera" : "web";

            tdSource.appendChild(sourceIcon);
            tdSource.appendChild(document.createTextNode(exp.source === "receipt" ? "レシートAI" : "手動"));

            const tdAmount = document.createElement("td");
            tdAmount.className = "amount-cell";
            tdAmount.textContent = `¥${exp.amount.toLocaleString()}`;

            tr.appendChild(tdDate);
            tr.appendChild(tdCat);
            tr.appendChild(tdDesc);
            tr.appendChild(tdSource);
            tr.appendChild(tdAmount);
            expensesTableBody.appendChild(tr);
          });
        } else {
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.style.textAlign = "center";
          td.textContent = "家計簿データが空です。";
          tr.appendChild(td);
          expensesTableBody.appendChild(tr);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  expenseForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = parseInt(document.getElementById("exp-amount").value, 10);
    const category = document.getElementById("exp-category").value;
    const description = document.getElementById("exp-description").value.trim();
    const date = document.getElementById("exp-date").value;

    const now = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    try {
      const res = await fetch("/api/expenses/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, category, description, date, time })
      });
      const data = await res.json();
      if (data.success) {
        expenseForm.reset();
        expDateInput.value = new Date().toISOString().slice(0, 10);
        fetchExpensesList();
      }
    } catch (e) {
      console.error(e);
    }
  });

  // AI Receipt Dropzone drag-drop
  if (receiptDropzone) {
    receiptDropzone.addEventListener("click", () => receiptFileInput.click());

    receiptDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      receiptDropzone.classList.add("dragover");
    });

    receiptDropzone.addEventListener("dragleave", () => {
      receiptDropzone.classList.remove("dragover");
    });

    receiptDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      receiptDropzone.classList.remove("dragover");
      if (e.dataTransfer.files.length > 0) {
        handleReceiptScan(e.dataTransfer.files[0]);
      }
    });

    receiptFileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        handleReceiptScan(e.target.files[0]);
      }
    });
  }

  async function handleReceiptScan(file) {
    if (!file.type.startsWith("image/")) {
      alert("レシート解析は画像ファイル（PNG/JPEG）のみ対応しています。");
      return;
    }

    scanStatus.classList.remove("hidden");
    scanStatusText.textContent = "レシート画像をアップロードしてAIに渡しています...";

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Str = reader.result.split(",")[1];
      const mimeType = file.type;

      try {
        const res = await fetch("/api/expenses/upload-receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: base64Str,
            mimeType: mimeType,
            additionalText: "WEB管理画面からアップロードされた画像レシート"
          })
        });
        const data = await res.json();

        if (data.success) {
          scanStatus.classList.add("hidden");
          receiptAiResponse.textContent = data.response;
          openModal(modalReceiptResult);
          fetchExpensesList();
        } else {
          throw new Error(data.message);
        }
      } catch (err) {
        scanStatus.classList.add("hidden");
        alert(`解析エラーが発生しました:\n${err.message}`);
      }
    };
    reader.readAsDataURL(file);
  }

  // H. SYSTEM CONFIG POLL
  async function fetchConfigSettings() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();

      if (data.success) {
        // Fill individual config form values
        document.getElementById("config-profile-username").value = data.user.username;
        document.getElementById("gemini-model-select").value = data.config.geminiModel;

        document.getElementById("backup-enable").checked = data.config.backupEnabled;
        document.getElementById("backup-folder-id").value = data.config.backupFolderId === "未設定" ? "" : data.config.backupFolderId;
        document.getElementById("backup-cron").value = data.config.backupCron;

        // UI access control for system_default bot settings
        const isSystemDefault = window.currentBotId === "system_default";
        const isAdmin = activeUserRole === "admin";
        const configDiscordCard = document.getElementById("config-discord-card");
        
        if (configDiscordCard) {
          if (isSystemDefault && !isAdmin) {
            configDiscordCard.classList.add("hidden");
          } else {
            configDiscordCard.classList.remove("hidden");
          }
        }

        // system_default を非管理者が見ている場合、Google連携・バックアップ・カレンダーを隠す
        const restrictedForNonAdmin = isSystemDefault && !isAdmin;
        ["config-google-section", "config-backup-section", "config-calendars-section"].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.classList.toggle("hidden", restrictedForNonAdmin);
        });

        // Fetch and fill Discord / Persona config values
        if (!isSystemDefault || isAdmin) {
          try {
            fetch("/api/settings/discord")
              .then(res => res.json())
              .then(discordData => {
                if (discordData.success) {
                  document.getElementById("discord-token").value = discordData.tokenMasked;
                  document.getElementById("discord-persona").value = discordData.persona;
                }
              })
              .catch(err => console.error("Failed to load Discord settings:", err));
          } catch (err) {
            console.error("Failed to load Discord settings:", err);
          }
        }

        // Render Calendars List (Matte Flat Style)
        const configCalendarsList = document.getElementById("config-calendars-list");
        if (configCalendarsList) {
          configCalendarsList.replaceChildren();
          const calendars = data.config.googleCalendars || [];
          if (calendars.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "登録されている同期カレンダーはありません。Google連携認証を完了させてください。";
            empty.style.fontSize = "0.8rem";
            empty.style.color = "var(--color-zinc-muted)";
            configCalendarsList.appendChild(empty);
          } else {
            calendars.forEach(cal => {
              const row = document.createElement("div");
              row.style.display = "flex";
              row.style.justifyContent = "space-between";
              row.style.alignItems = "center";
              row.style.padding = "12px 0";
              row.style.border = "none";
              row.style.borderBottom = "1px solid var(--border-divider)";
              row.style.backgroundColor = "transparent";

              const leftInfo = document.createElement("div");
              leftInfo.style.display = "flex";
              leftInfo.style.flexDirection = "column";
              leftInfo.style.gap = "2px";

              const calSummary = document.createElement("span");
              calSummary.textContent = cal.summary || "外部連携カレンダー";
              calSummary.style.fontSize = "0.85rem";
              calSummary.style.fontWeight = "700";
              calSummary.style.color = "var(--color-white)";

              const calId = document.createElement("span");
              calId.textContent = cal.id;
              calId.style.fontSize = "0.7rem";
              calId.style.color = "var(--color-zinc-muted)";
              calId.style.fontFamily = "var(--font-family-mono)";

              leftInfo.appendChild(calSummary);
              leftInfo.appendChild(calId);

              const btnDelete = document.createElement("button");
              btnDelete.className = "btn-trash";
              btnDelete.style.width = "28px";
              btnDelete.style.height = "28px";
              btnDelete.type = "button";

              const trashIcon = document.createElement("span");
              trashIcon.className = "material-symbols-outlined";
              trashIcon.textContent = "delete";
              trashIcon.style.fontSize = "1.0rem";

              btnDelete.appendChild(trashIcon);
              btnDelete.addEventListener("click", () => handleDeleteCalendarId(cal.id));

              row.appendChild(leftInfo);
              row.appendChild(btnDelete);
              configCalendarsList.appendChild(row);
            });
          }
        }
      }

      // Load AI Credentials List
      fetchCredentialsSettings();
    } catch (e) {
      console.error(e);
    }
  }

  // Handle Profile settings update
  const profileConfigForm = document.getElementById("profile-config-form");
  if (profileConfigForm) {
    profileConfigForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("config-profile-username").value.trim();
      try {
        const res = await fetch("/api/settings/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (data.success) {
          alert("プロフィールを更新しました。");
          initAppSession();
        } else {
          alert(data.message);
        }
      } catch (err) {
        alert("通信エラーが発生しました。");
      }
    });
  }

  // Handle Gemini settings update
  const geminiConfigForm = document.getElementById("gemini-config-form");
  if (geminiConfigForm) {
    geminiConfigForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const apiKey = document.getElementById("gemini-api-key").value.trim();
      const model = document.getElementById("gemini-model-select").value;
      try {
        const res = await fetch("/api/settings/gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, model })
        });
        const data = await res.json();
        if (data.success) {
          alert("Gemini 設定を更新しました。");
          document.getElementById("gemini-api-key").value = "";
          fetchConfigSettings();
        } else {
          alert(data.message);
        }
      } catch (err) {
        alert("通信エラーが発生しました。");
      }
    });
  }

  // Handle Discord & Persona settings update
  const discordConfigForm = document.getElementById("discord-config-form");
  if (discordConfigForm) {
    discordConfigForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = document.getElementById("discord-token").value.trim();
      const persona = document.getElementById("discord-persona").value.trim();

      try {
        const res = await fetch("/api/settings/discord", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, persona })
        });
        const data = await res.json();
        if (data.success) {
          alert(data.message);
          fetchConfigSettings();
        } else {
          alert(data.message);
        }
      } catch (err) {
        alert("通信エラーが発生しました。");
      }
    });
  }



  // Handle Google OAuth trigger
  const btnGoogleAuth = document.getElementById("btn-google-auth");
  if (btnGoogleAuth) {
    btnGoogleAuth.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/settings/google/oauth/url");
        const data = await res.json();
        if (data.success) {
          window.location.href = data.url;
        } else {
          alert(data.message);
        }
      } catch (err) {
        alert("認証URLの取得に失敗しました。システム共通の Google OAuth 設定が登録されていることを確認してください。");
      }
    });
  }

  // Handle Backup config update
  const backupConfigForm = document.getElementById("backup-config-form");
  if (backupConfigForm) {
    backupConfigForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const enabled = document.getElementById("backup-enable").checked;
      const folderId = document.getElementById("backup-folder-id").value.trim();
      const cron = document.getElementById("backup-cron").value.trim();

      try {
        const res = await fetch("/api/settings/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled, folderId, cron })
        });
        const data = await res.json();
        if (data.success) {
          alert("バックアップ設定を保存しました。");
          fetchConfigSettings();
        } else {
          alert(`設定の保存に失敗しました: ${data.message}`);
        }
      } catch (e) {
        console.error(e);
        alert("通信エラーが発生しました。");
      }
    });
  }

  // Handle Manual Backup Trigger
  const btnTriggerBackup = document.getElementById("btn-trigger-backup");
  if (btnTriggerBackup) {
    btnTriggerBackup.addEventListener("click", async () => {
      if (!document.getElementById("backup-enable").checked) {
        alert("手動バックアップを実行するには、先にバックアップを有効にして設定を保存してください。");
        return;
      }

      const originalText = btnTriggerBackup.textContent;
      btnTriggerBackup.textContent = "バックアップ実行中...";
      btnTriggerBackup.disabled = true;

      try {
        const res = await fetch("/api/settings/backup/trigger", {
          method: "POST"
        });
        const data = await res.json();
        if (data.success) {
          alert(`バックアップが完了しました！\nURL: ${data.url}`);
        } else {
          alert(`バックアップ失敗: ${data.message}`);
        }
      } catch (e) {
        console.error(e);
        alert("バックアップ処理中にエラーが発生しました。");
      } finally {
        btnTriggerBackup.textContent = originalText;
        btnTriggerBackup.disabled = false;
      }
    });
  }

  // Handle calendar ID deletion
  async function handleDeleteCalendarId(calendarId) {
    if (!confirm(`本当にカレンダーID "${calendarId}" を同期一覧から削除しますか？`)) return;
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (data.success) {
        const currentList = (data.config.googleCalendars || []).map(c => c.id);
        const newList = currentList.filter(id => id !== calendarId);

        const saveRes = await fetch("/api/settings/calendars", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendars: newList })
        });
        const saveVal = await saveRes.json();
        if (saveVal.success) {
          fetchConfigSettings();
        } else {
          alert(saveVal.message);
        }
      }
    } catch (e) {
      console.error(e);
      alert("通信エラーが発生しました。");
    }
  }

  // Handle adding new calendar ID
  const configCalendarForm = document.getElementById("config-calendar-form");
  if (configCalendarForm) {
    configCalendarForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("config-new-calendar-id");
      const calendarId = input.value.trim();
      if (!calendarId) return;

      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        if (data.success) {
          const currentList = (data.config.googleCalendars || []).map(c => c.id);
          if (currentList.includes(calendarId)) {
            alert("このカレンダーIDは既に追加されています。");
            return;
          }
          currentList.push(calendarId);

          const saveRes = await fetch("/api/settings/calendars", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ calendars: currentList })
          });
          const saveVal = await saveRes.json();
          if (saveVal.success) {
            input.value = "";
            fetchConfigSettings();
          } else {
            alert(saveVal.message);
          }
        }
      } catch (e) {
        console.error(e);
        alert("通信エラーが発生しました。");
      }
    });
  }

  // ==========================================
  // AI CREDENTIALS MANAGEMENT
  // ==========================================
  async function fetchCredentialsSettings() {
    const configCredentialsList = document.getElementById("config-credentials-list");
    if (!configCredentialsList) return;

    configCredentialsList.replaceChildren();

    try {
      const res = await fetch("/api/credentials");
      const data = await res.json();

      if (data.success && data.credentials.length > 0) {
        data.credentials.forEach(cred => {
          const tr = document.createElement("tr");
          tr.style.borderBottom = "1px solid var(--border-matte)";

          const tdService = document.createElement("td");
          tdService.style.padding = "12px 10px";
          tdService.style.fontSize = "0.85rem";
          tdService.style.color = "var(--color-white)";
          tdService.style.fontWeight = "700";
          tdService.textContent = cred.serviceName;

          const tdUser = document.createElement("td");
          tdUser.style.padding = "12px 10px";
          tdUser.style.fontSize = "0.85rem";
          tdUser.style.fontFamily = "var(--font-family-mono)";
          tdUser.textContent = cred.username;

          const tdPass = document.createElement("td");
          tdPass.style.padding = "12px 10px";
          tdPass.style.fontSize = "0.85rem";
          tdPass.style.color = "var(--color-zinc-muted)";
          tdPass.style.fontFamily = "var(--font-family-mono)";
          tdPass.textContent = "••••••••••••";

          const tdDate = document.createElement("td");
          tdDate.style.padding = "12px 10px";
          tdDate.style.fontSize = "0.75rem";
          tdDate.style.color = "var(--color-zinc-muted)";
          tdDate.textContent = cred.updatedAt;

          const tdActions = document.createElement("td");
          tdActions.style.padding = "12px 10px";
          tdActions.style.textAlign = "right";

          const btnDel = document.createElement("button");
          btnDel.className = "btn-credential-delete";
          btnDel.type = "button";

          const delIcon = document.createElement("span");
          delIcon.className = "material-symbols-outlined";
          delIcon.style.fontSize = "0.9rem";
          delIcon.textContent = "delete";

          btnDel.appendChild(delIcon);
          btnDel.appendChild(document.createTextNode(" 削除"));

          btnDel.addEventListener("click", () => handleDeleteCredential(cred.serviceName));

          tdActions.appendChild(btnDel);

          tr.appendChild(tdService);
          tr.appendChild(tdUser);
          tr.appendChild(tdPass);
          tr.appendChild(tdDate);
          tr.appendChild(tdActions);

          configCredentialsList.appendChild(tr);
        });
      } else {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.style.textAlign = "center";
        td.style.padding = "20px";
        td.style.color = "var(--color-zinc-muted)";
        td.style.fontSize = "0.8rem";
        td.textContent = "登録されているAI用認証情報はありません。";
        tr.appendChild(td);
        configCredentialsList.appendChild(tr);
      }
    } catch (err) {
      console.error("認証情報取得失敗:", err);
    }
  }

  credentialForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const serviceName = document.getElementById("cred-service-name").value.trim().toLowerCase();
    const username = document.getElementById("cred-username").value.trim();
    const password = document.getElementById("cred-password").value;

    try {
      const res = await fetch("/api/credentials/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName, username, password })
      });
      const data = await res.json();
      if (data.success) {
        closeModal(modalCredential);
        credentialForm.reset();
        fetchCredentialsSettings();
      } else {
        alert(`登録失敗: ${data.message}`);
      }
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。");
    }
  });

  async function handleDeleteCredential(serviceName) {
    if (!confirm(`本当にサービス [${serviceName}] のログイン資格情報を完全に削除しますか？`)) return;
    try {
      const res = await fetch("/api/credentials/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName })
      });
      const data = await res.json();
      if (data.success) {
        fetchCredentialsSettings();
      } else {
        alert("削除に失敗しました。");
      }
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。");
    }
  }

  // ==========================================
  // ADMIN PAGE LOGIC
  // ==========================================

  function maskDiscordId(discordId) {
    if (!discordId || discordId.length < 6) return discordId || "";
    return discordId.substring(0, 4) + "****" + discordId.substring(discordId.length - 4);
  }

  async function fetchAdminData() {
    if (activeUserRole !== "admin") return;
    await Promise.all([
      fetchAdminStats(),
      fetchAdminUsers(),
      fetchAdminBots(),
      fetchAdminInviteCodes()
    ]);
  }

  async function fetchAdminStats() {
    try {
      const res = await originalFetch("/api/admin/stats");
      const data = await res.json();
      if (data.success) {
        const s = data.stats;
        document.getElementById("admin-stat-users").textContent = s.totalUsers;
        document.getElementById("admin-stat-bots").textContent = s.totalBots;
        document.getElementById("admin-stat-suspended").textContent = s.suspendedBots;
        document.getElementById("admin-stat-invites").textContent = s.availableInviteCodes;
      }
    } catch (err) {
      console.error("Admin stats fetch error");
    }
  }

  async function fetchAdminUsers() {
    const tbody = document.getElementById("admin-users-tbody");
    if (!tbody) return;
    tbody.replaceChildren();

    try {
      const res = await originalFetch("/api/admin/users");
      const data = await res.json();
      if (!data.success || !data.users.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.style.textAlign = "center";
        td.style.padding = "20px";
        td.style.color = "var(--color-zinc-muted)";
        td.style.fontSize = "0.8rem";
        td.textContent = "登録済みユーザーはいません。";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      data.users.forEach(user => {
        const tr = document.createElement("tr");

        // ユーザー名
        const tdName = document.createElement("td");
        tdName.className = "admin-table-td";
        tdName.style.fontWeight = "700";
        tdName.style.color = "var(--color-white)";
        tdName.textContent = user.username;
        tr.appendChild(tdName);

        // Discord ID (マスク表示)
        const tdId = document.createElement("td");
        tdId.className = "admin-table-td admin-discord-id";
        tdId.textContent = maskDiscordId(user.discord_id);
        tr.appendChild(tdId);

        // ロールバッジ
        const tdRole = document.createElement("td");
        tdRole.className = "admin-table-td";
        const roleBadge = document.createElement("span");
        roleBadge.className = `admin-role-badge role-${user.role || "user"}`;
        roleBadge.textContent = (user.role || "user").toUpperCase();
        tdRole.appendChild(roleBadge);
        tr.appendChild(tdRole);

        // 登録日
        const tdDate = document.createElement("td");
        tdDate.className = "admin-table-td";
        tdDate.style.fontSize = "0.8rem";
        tdDate.style.color = "var(--color-zinc-muted)";
        tdDate.textContent = user.created_at;
        tr.appendChild(tdDate);

        // 操作
        const tdAction = document.createElement("td");
        tdAction.className = "admin-table-td";
        tdAction.style.textAlign = "right";

        if (user.discord_id !== activeUserId) {
          const btn = document.createElement("button");
          btn.className = `admin-btn-action ${user.role === "admin" ? "" : "btn-promote"}`;
          btn.type = "button";
          const newRole = user.role === "admin" ? "user" : "admin";
          btn.textContent = user.role === "admin" ? "降格" : "管理者に";
          btn.addEventListener("click", async () => {
            const confirmMsg = newRole === "admin"
              ? `ユーザー「${user.username}」を Admin に昇格しますか？`
              : `ユーザー「${user.username}」の Admin 権限を解除しますか？`;
            if (!confirm(confirmMsg)) return;
            try {
              const r = await originalFetch("/api/admin/users/role", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId: user.discord_id, role: newRole })
              });
              const d = await r.json();
              if (d.success) {
                fetchAdminUsers();
                fetchAdminStats();
              } else {
                // TODO(security): Replace alert with a modal in production
                alert(d.message);
              }
            } catch (e) {
              console.error("Role change failed");
            }
          });
          tdAction.appendChild(btn);
        } else {
          const selfLabel = document.createElement("span");
          selfLabel.style.fontSize = "0.75rem";
          selfLabel.style.color = "var(--color-zinc-muted)";
          selfLabel.textContent = "自分";
          tdAction.appendChild(selfLabel);
        }
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
      });
    } catch (err) {
      console.error("Admin users fetch error");
    }
  }

  async function fetchAdminBots() {
    const tbody = document.getElementById("admin-bots-tbody");
    if (!tbody) return;
    tbody.replaceChildren();

    try {
      const res = await originalFetch("/api/admin/bots");
      const data = await res.json();
      if (!data.success || !data.bots.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.style.textAlign = "center";
        td.style.padding = "20px";
        td.style.color = "var(--color-zinc-muted)";
        td.style.fontSize = "0.8rem";
        td.textContent = "Botは登録されていません。";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      data.bots.forEach(bot => {
        const tr = document.createElement("tr");

        // Bot名
        const tdName = document.createElement("td");
        tdName.className = "admin-table-td";
        tdName.style.fontWeight = "700";
        tdName.style.color = "var(--color-white)";
        tdName.textContent = bot.discord_username || bot.name;
        tr.appendChild(tdName);

        // 所有者
        const tdOwner = document.createElement("td");
        tdOwner.className = "admin-table-td";
        tdOwner.textContent = bot.owner_username;
        tr.appendChild(tdOwner);

        // ステータス
        const tdStatus = document.createElement("td");
        tdStatus.className = "admin-table-td";
        const statusBadge = document.createElement("span");
        if (bot.suspended) {
          statusBadge.className = "admin-status-badge status-suspended";
          statusBadge.textContent = "差し押さえ中";
        } else if (bot.hasCustomToken) {
          statusBadge.className = "admin-status-badge status-active";
          statusBadge.textContent = bot.isRunning ? "起動中" : "停止";
        } else {
          statusBadge.className = "admin-status-badge status-default";
          statusBadge.textContent = "デフォルト";
        }
        tdStatus.appendChild(statusBadge);
        tr.appendChild(tdStatus);

        // 作成日
        const tdDate = document.createElement("td");
        tdDate.className = "admin-table-td";
        tdDate.style.fontSize = "0.8rem";
        tdDate.style.color = "var(--color-zinc-muted)";
        tdDate.textContent = bot.created_at;
        tr.appendChild(tdDate);

        // 操作
        const tdAction = document.createElement("td");
        tdAction.className = "admin-table-td";
        tdAction.style.textAlign = "right";

        if (bot.suspended) {
          const btnUnsuspend = document.createElement("button");
          btnUnsuspend.className = "admin-btn-action btn-success";
          btnUnsuspend.type = "button";
          btnUnsuspend.textContent = "解除";
          btnUnsuspend.addEventListener("click", async () => {
            if (!confirm(`Bot「${bot.name}」の差し押さえを解除しますか？`)) return;
            try {
              const r = await originalFetch("/api/admin/bots/unsuspend", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ botId: bot.id })
              });
              const d = await r.json();
              if (d.success) {
                fetchAdminBots();
                fetchAdminStats();
              }
            } catch (e) {
              console.error("Unsuspend failed");
            }
          });
          tdAction.appendChild(btnUnsuspend);
        } else {
          const btnSuspend = document.createElement("button");
          btnSuspend.className = "admin-btn-action btn-danger";
          btnSuspend.type = "button";
          btnSuspend.textContent = "差し押さえ";
          btnSuspend.addEventListener("click", async () => {
            if (!confirm(`Bot「${bot.name}」を差し押さえますか？\nDiscordクライアントが停止され、所有者は再起動できなくなります。`)) return;
            try {
              const r = await originalFetch("/api/admin/bots/suspend", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ botId: bot.id })
              });
              const d = await r.json();
              if (d.success) {
                fetchAdminBots();
                fetchAdminStats();
              }
            } catch (e) {
              console.error("Suspend failed");
            }
          });
          tdAction.appendChild(btnSuspend);
        }
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
      });
    } catch (err) {
      console.error("Admin bots fetch error");
    }
  }

  async function fetchAdminInviteCodes() {
    const tbody = document.getElementById("admin-invites-tbody");
    if (!tbody) return;
    tbody.replaceChildren();

    try {
      const res = await originalFetch("/api/admin/invite-codes");
      const data = await res.json();
      if (!data.success || !data.codes.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.style.textAlign = "center";
        td.style.padding = "20px";
        td.style.color = "var(--color-zinc-muted)";
        td.style.fontSize = "0.8rem";
        td.textContent = "招待コードは登録されていません。";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      data.codes.forEach(code => {
        const tr = document.createElement("tr");

        // コード
        const tdCode = document.createElement("td");
        tdCode.className = "admin-table-td";
        tdCode.style.fontFamily = "var(--font-family-mono)";
        tdCode.style.fontWeight = "600";
        tdCode.textContent = code.code;
        tr.appendChild(tdCode);

        // ステータス
        const tdStatus = document.createElement("td");
        tdStatus.className = "admin-table-td";
        const statusSpan = document.createElement("span");
        if (code.used_by) {
          statusSpan.className = "invite-status-used";
          statusSpan.textContent = "使用済み";
        } else {
          statusSpan.className = "invite-status-available";
          statusSpan.textContent = "利用可能";
        }
        tdStatus.appendChild(statusSpan);
        tr.appendChild(tdStatus);

        // 使用者
        const tdUsedBy = document.createElement("td");
        tdUsedBy.className = "admin-table-td";
        tdUsedBy.style.color = "var(--color-zinc-muted)";
        tdUsedBy.textContent = code.used_by ? maskDiscordId(code.used_by) : "—";
        tr.appendChild(tdUsedBy);

        // 作成日
        const tdDate = document.createElement("td");
        tdDate.className = "admin-table-td";
        tdDate.style.fontSize = "0.8rem";
        tdDate.style.color = "var(--color-zinc-muted)";
        tdDate.textContent = code.created_at;
        tr.appendChild(tdDate);

        tbody.appendChild(tr);
      });
    } catch (err) {
      console.error("Admin invite codes fetch error");
    }
  }

  // Admin Invite Code Form
  const adminInviteForm = document.getElementById("admin-invite-form");
  if (adminInviteForm) {
    adminInviteForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("admin-invite-code-input");
      const code = input.value.trim();
      if (!code) return;

      try {
        const res = await originalFetch("/api/admin/invite-codes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data.success) {
          input.value = "";
          fetchAdminInviteCodes();
          fetchAdminStats();
        } else {
          // TODO(security): Replace alert with a modal in production
          alert(data.message);
        }
      } catch (err) {
        console.error("Invite code creation failed");
      }
    });
  }

  // Admin Default Bot Token Form
  const adminDefaultBotForm = document.getElementById("admin-default-bot-form");
  if (adminDefaultBotForm) {
    adminDefaultBotForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("admin-default-bot-token");
      const token = input.value.trim();
      if (!token) return;

      try {
        const res = await originalFetch("/api/admin/default-bot/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (data.success) {
          input.value = "";
          alert("システムデフォルト Bot のトークンを更新しました！");
        } else {
          alert(`更新失敗: ${data.message}`);
        }
      } catch (err) {
        console.error("Default bot token update failed");
        alert("更新に失敗しました。");
      }
    });
  }

  // ==========================================
  // PLAYBOOKS MANAGEMENT
  // ==========================================
  async function fetchPlaybooksList() {
    const container = document.getElementById("playbooks-list-container");
    if (!container) return;

    container.replaceChildren();

    const searchInput = document.getElementById("playbook-search-input");
    const query = searchInput ? searchInput.value.trim() : "";

    try {
      const res = await fetch(`/api/playbooks?query=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (data.success && data.playbooks.length > 0) {
        data.playbooks.forEach(pb => {
          const card = document.createElement("div");
          card.className = "card-item glass hover-lift";
          card.style.flexDirection = "column";
          card.style.alignItems = "stretch";
          card.style.padding = "16px";
          card.style.gap = "8px";
          card.style.cursor = "pointer";

          // Top row: Title and Delete button
          const topRow = document.createElement("div");
          topRow.style.display = "flex";
          topRow.style.justifyContent = "space-between";
          topRow.style.alignItems = "center";

          const title = document.createElement("div");
          title.className = "card-title";
          title.textContent = pb.title;
          title.style.fontSize = "1.0rem";

          const nameTag = document.createElement("span");
          nameTag.className = "badge badge-accent";
          nameTag.style.marginLeft = "8px";
          nameTag.style.fontSize = "0.7rem";
          nameTag.textContent = pb.name;
          title.appendChild(nameTag);

          const btnTrash = document.createElement("button");
          btnTrash.className = "btn-trash";
          btnTrash.type = "button";
          btnTrash.style.width = "28px";
          btnTrash.style.height = "28px";

          const trashIcon = document.createElement("span");
          trashIcon.className = "material-symbols-outlined";
          trashIcon.style.fontSize = "1.1rem";
          trashIcon.textContent = "delete";
          btnTrash.appendChild(trashIcon);

          // Stop propagation so clicking delete doesn't load into edit form
          btnTrash.addEventListener("click", (e) => {
            e.stopPropagation();
            handleDeletePlaybook(pb.name);
          });

          topRow.appendChild(title);
          topRow.appendChild(btnTrash);

          // Middle row: Description
          const desc = document.createElement("div");
          desc.className = "card-desc";
          desc.textContent = pb.description || "説明なし";

          // Keywords list
          const keywordsRow = document.createElement("div");
          keywordsRow.style.display = "flex";
          keywordsRow.style.flexWrap = "wrap";
          keywordsRow.style.gap = "6px";
          keywordsRow.style.marginTop = "4px";

          if (pb.keywords && pb.keywords.length > 0) {
            pb.keywords.forEach(kw => {
              const kwBadge = document.createElement("span");
              kwBadge.className = "badge";
              kwBadge.style.backgroundColor = "rgba(255,255,255,0.06)";
              kwBadge.style.border = "1px solid var(--border-matte)";
              kwBadge.style.color = "var(--color-zinc-muted)";
              kwBadge.style.fontSize = "0.65rem";
              kwBadge.textContent = kw;
              keywordsRow.appendChild(kwBadge);
            });
          }

          card.appendChild(topRow);
          card.appendChild(desc);
          card.appendChild(keywordsRow);

          // Clicking card loads it into the editor form
          card.addEventListener("click", () => {
            document.getElementById("playbook-name").value = pb.name;
            document.getElementById("playbook-title").value = pb.title;
            document.getElementById("playbook-keywords").value = (pb.keywords || []).join(", ");
            document.getElementById("playbook-description").value = pb.description || "";
            document.getElementById("playbook-steps").value = pb.steps || "";
            
            // Highlight name field briefly to show it is loaded
            const nameInput = document.getElementById("playbook-name");
            nameInput.style.borderColor = "var(--color-primary)";
            setTimeout(() => { nameInput.style.borderColor = ""; }, 1000);
          });

          container.appendChild(card);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "glass";
        empty.style.padding = "20px";
        empty.style.textAlign = "center";
        empty.style.color = "var(--color-zinc-muted)";
        empty.style.fontSize = "0.85rem";
        empty.textContent = "Playbookが登録されていません。";
        container.appendChild(empty);
      }
    } catch (e) {
      console.error("Playbook一覧の取得失敗:", e);
    }
  }

  // Handle Playbook form submit
  const playbookForm = document.getElementById("playbook-form");
  if (playbookForm) {
    playbookForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("playbook-name").value.trim();
      const title = document.getElementById("playbook-title").value.trim();
      const keywordsRaw = document.getElementById("playbook-keywords").value.trim();
      const description = document.getElementById("playbook-description").value.trim();
      const steps = document.getElementById("playbook-steps").value.trim();

      const keywords = keywordsRaw
        ? keywordsRaw.split(",").map(k => k.trim()).filter(k => k.length > 0)
        : [];

      try {
        const res = await fetch("/api/playbooks/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, title, keywords, description, steps })
        });
        const data = await res.json();
        if (data.success) {
          alert("Playbookを保存しました。");
          playbookForm.reset();
          fetchPlaybooksList();
        } else {
          alert(`保存に失敗しました: ${data.message}`);
        }
      } catch (err) {
        console.error(err);
        alert("通信エラーが発生しました。");
      }
    });
  }

  // Handle Playbook deletion
  async function handleDeletePlaybook(name) {
    if (!confirm(`本当にこのPlaybook [${name}] を削除しますか？`)) return;
    try {
      const res = await fetch("/api/playbooks/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.success) {
        fetchPlaybooksList();
      } else {
        alert(`削除に失敗しました: ${data.message}`);
      }
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。");
    }
  }

  // Handle search triggers
  const btnPlaybookSearch = document.getElementById("btn-playbook-search");
  if (btnPlaybookSearch) {
    btnPlaybookSearch.addEventListener("click", fetchPlaybooksList);
  }
  const playbookSearchInput = document.getElementById("playbook-search-input");
  if (playbookSearchInput) {
    playbookSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        fetchPlaybooksList();
      }
    });
  }

  // Handle popstate event (back/forward browser buttons)
  window.addEventListener("popstate", () => {
    applyRoute(window.location.pathname);
  });

  // On page load, try auto-login
  initAppSession();

});
