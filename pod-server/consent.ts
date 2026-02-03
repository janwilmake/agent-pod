/// <reference types="@cloudflare/workers-types" />

import type { Env, XUser, FileNode } from "./types";
import { getCorsHeaders, USER_DO_PREFIX } from "./utils";

export async function showConsentPage(
  user: XUser,
  clientId: string,
  redirectUri: string,
  state: string | null,
  scopes: string[],
  resource: string | null,
  env: Env
): Promise<Response> {
  const userDO = env.UserDO.get(
    env.UserDO.idFromName(`${USER_DO_PREFIX}${user.id}`)
  );
  const userFiles = await userDO.getUserFiles(user.username);

  const variableScopes: string[] = [];
  const specificScopes: {
    scope: string;
    exists: boolean;
    action: string;
    resource: string;
  }[] = [];

  for (const scope of scopes) {
    if (scope.includes(":{resource}") || scope.includes(":{*}")) {
      const action = scope.split(":")[0];
      if (!variableScopes.includes(action)) {
        variableScopes.push(action);
      }
    } else if (scope.includes(":")) {
      const [action, res] = scope.split(":", 2);
      const fullPath = `/${user.username}/${res}`;
      const exists = userFiles.some((file: FileNode) => file.path === fullPath);
      specificScopes.push({ scope, exists, action, resource: res });
    } else {
      specificScopes.push({
        scope,
        exists: true,
        action: scope,
        resource: "all files",
      });
    }
  }

  const hasVariableScopes = variableScopes.length > 0;
  const hasSpecificScopes = specificScopes.length > 0;

  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Authorize ${clientId}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              win95: {
                gray: '#c0c0c0',
                darkgray: '#808080',
                lightgray: '#dfdfdf',
                blue: '#000080',
                lightblue: '#1084d0',
              }
            }
          }
        }
      }
    </script>
    <style>
      body { font-family: 'Tahoma', 'MS Sans Serif', sans-serif; font-size: 11px; }
      .win95-window {
        background: #c0c0c0;
        border: 2px solid;
        border-color: #dfdfdf #404040 #404040 #dfdfdf;
        box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #808080;
      }
      .win95-titlebar {
        background: linear-gradient(90deg, #000080, #1084d0);
        padding: 3px 4px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .win95-btn {
        background: #c0c0c0;
        border: 2px solid;
        border-color: #dfdfdf #404040 #404040 #dfdfdf;
        box-shadow: inset 1px 1px 0 #fff;
        padding: 4px 16px;
        font-size: 11px;
        font-family: 'Tahoma', sans-serif;
        min-width: 75px;
        cursor: pointer;
      }
      .win95-btn:hover { background: #d4d4d4; }
      .win95-btn:active {
        border-color: #404040 #dfdfdf #dfdfdf #404040;
        box-shadow: inset -1px -1px 0 #fff;
        padding: 5px 15px 3px 17px;
      }
      .win95-btn:disabled {
        color: #808080;
        text-shadow: 1px 1px 0 #fff;
        cursor: not-allowed;
      }
      .win95-btn-primary {
        background: #c0c0c0;
        border: 3px solid;
        border-color: #dfdfdf #404040 #404040 #dfdfdf;
        outline: 1px dotted #000;
        outline-offset: -4px;
      }
      .win95-inset {
        background: #fff;
        border: 2px solid;
        border-color: #808080 #dfdfdf #dfdfdf #808080;
        box-shadow: inset 1px 1px 0 #404040;
      }
      .win95-outset {
        background: #c0c0c0;
        border: 2px solid;
        border-color: #dfdfdf #404040 #404040 #dfdfdf;
      }
      .win95-checkbox {
        appearance: none;
        width: 13px;
        height: 13px;
        background: #fff;
        border: 2px solid;
        border-color: #808080 #dfdfdf #dfdfdf #808080;
        box-shadow: inset 1px 1px 0 #404040;
        cursor: pointer;
        vertical-align: middle;
        margin-right: 4px;
      }
      .win95-checkbox:checked {
        background: #fff url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 5l3 3 5-6" stroke="%23000" stroke-width="2" fill="none"/></svg>') center/8px no-repeat;
      }
      .win95-input {
        background: #fff;
        border: 2px solid;
        border-color: #808080 #dfdfdf #dfdfdf #808080;
        box-shadow: inset 1px 1px 0 #404040;
        padding: 3px 4px;
        font-family: 'Tahoma', sans-serif;
        font-size: 11px;
      }
      .win95-input:focus {
        outline: none;
      }
      .win95-groupbox {
        border: 2px groove #c0c0c0;
        margin-top: 8px;
        padding: 12px 8px 8px;
        position: relative;
        background: #c0c0c0;
      }
      .win95-groupbox-label {
        position: absolute;
        top: -8px;
        left: 8px;
        background: #c0c0c0;
        padding: 0 4px;
        font-weight: normal;
      }
      .win95-title-btn {
        background: #c0c0c0;
        border: 2px solid;
        border-color: #dfdfdf #404040 #404040 #dfdfdf;
        width: 16px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        font-weight: bold;
        font-family: 'Marlett', sans-serif;
        cursor: pointer;
      }
      .win95-title-btn:active {
        border-color: #404040 #dfdfdf #dfdfdf #404040;
      }
      .win95-list {
        background: #fff;
        border: 2px solid;
        border-color: #808080 #dfdfdf #dfdfdf #808080;
        box-shadow: inset 1px 1px 0 #404040;
      }
      .win95-list-item {
        padding: 2px 4px;
        cursor: pointer;
      }
      .win95-list-item:hover {
        background: #000080;
        color: #fff;
      }
      .win95-statusbar {
        background: #c0c0c0;
        border-top: 2px solid;
        border-color: #808080 #dfdfdf #dfdfdf #808080;
        padding: 2px 4px;
        font-size: 11px;
      }
      .win95-divider {
        height: 2px;
        background: linear-gradient(to bottom, #808080 0%, #808080 50%, #fff 50%, #fff 100%);
        margin: 8px 0;
      }
      .win95-badge {
        display: inline-block;
        padding: 1px 6px;
        font-size: 10px;
        font-weight: bold;
      }
      .win95-badge-read { background: #000080; color: #fff; }
      .win95-badge-write { background: #800000; color: #fff; }
      .win95-badge-append { background: #008000; color: #fff; }
    </style>
</head>
<body class="bg-[#008080] min-h-screen p-2 md:p-4 flex items-center justify-center">
    <div class="w-full max-w-2xl">
        <div class="win95-window">
            <div class="win95-titlebar">
                <div class="flex items-center">
                    <span class="text-white font-bold text-xs">🔐 Authorize Application</span>
                </div>
                <div class="flex gap-[2px]">
                    <button class="win95-title-btn" title="Minimize">_</button>
                    <button class="win95-title-btn" title="Maximize">□</button>
                    <button class="win95-title-btn" title="Close">×</button>
                </div>
            </div>

            <div class="p-3">
                <!-- User Info -->
                <div class="win95-groupbox mb-3">
                    <span class="win95-groupbox-label">Logged in as</span>
                    <div class="flex items-center">
                        <img src="${user.profile_image_url || "https://via.placeholder.com/32"}"
                             alt="Avatar"
                             class="w-8 h-8 mr-3"
                             style="image-rendering: auto;">
                        <div>
                            <div class="font-bold">${user.name} ${user.verified ? "✓" : ""}</div>
                            <div class="text-[10px] text-gray-600">@${user.username}</div>
                        </div>
                    </div>
                </div>

                <!-- Request Info -->
                <div class="win95-inset p-2 mb-3">
                    <div class="flex items-start">
                        <span class="text-2xl mr-2">⚠️</span>
                        <div>
                            <p class="mb-1"><strong>${clientId}</strong> is requesting access to your files.</p>
                            <p class="text-[10px] text-gray-600">Do you want to allow this application to access your data?</p>
                        </div>
                    </div>
                </div>

                <form method="POST" action="/consent">
                    <input type="hidden" name="client_id" value="${clientId}">
                    <input type="hidden" name="redirect_uri" value="${redirectUri}">
                    <input type="hidden" name="state" value="${state || ""}">
                    <input type="hidden" name="resource" value="${resource || ""}">
                    <input type="hidden" name="user_id" value="${user.id}">
                    <input type="hidden" name="original_scopes" value="${scopes.join(" ")}">

                    ${hasVariableScopes ? `
                    <div class="win95-groupbox mb-3">
                        <span class="win95-groupbox-label">📂 Resource Permissions</span>
                        <p class="mb-2">The application requests these permissions:</p>

                        <div class="flex flex-wrap gap-1 mb-3">
                            ${variableScopes.map((action) => `
                                <span class="win95-badge win95-badge-${action}">${action.toUpperCase()}</span>
                            `).join("")}
                        </div>

                        <p class="mb-2">Select files/folders to grant access:</p>

                        <div class="win95-list max-h-48 overflow-y-auto mb-2">
                            ${generateFileTree(userFiles, user.username)}
                        </div>

                        <div class="flex gap-1 mb-2">
                            <button type="button" onclick="toggleSelectAll()" id="selectAllBtn" class="win95-btn text-[10px]">Select All</button>
                            <button type="button" onclick="clearSelection()" class="win95-btn text-[10px]">Clear All</button>
                        </div>

                        <div class="win95-inset p-2 bg-[#ffffcc]">
                            <span class="text-2xl mr-1">💡</span>
                            <span class="text-[10px]">You must select at least one resource to continue.</span>
                        </div>

                        <input type="hidden" name="selected_resources" id="selectedResources" value="">
                    </div>
                    ` : ""}

                    ${hasSpecificScopes ? `
                    <div class="win95-groupbox mb-3">
                        <span class="win95-groupbox-label">📄 Specific Permissions</span>
                        <div class="win95-list">
                            ${specificScopes.map((s) => `
                                <div class="p-2 border-b border-gray-300 last:border-b-0">
                                    <div class="flex items-center justify-between">
                                        <div class="flex items-center">
                                            <span class="win95-badge win95-badge-${s.action} mr-2">${s.action.toUpperCase()}</span>
                                            <span class="font-bold">${s.resource}</span>
                                        </div>
                                        <span class="text-[10px] ${s.exists ? "text-green-700" : "text-blue-700"}">
                                            ${s.exists ? "✓ Exists" : "➕ Will be created"}
                                        </span>
                                    </div>
                                    <div class="text-[10px] text-gray-600 mt-1">${getScopeDescription(s.action, s.resource)}</div>
                                </div>
                            `).join("")}
                        </div>
                    </div>
                    ` : ""}

                    <div class="win95-divider"></div>

                    <div class="flex justify-center gap-2">
                        <button type="submit"
                                name="action"
                                value="approve"
                                ${hasVariableScopes ? 'id="approveBtn" disabled' : ""}
                                class="win95-btn win95-btn-primary">
                            ✓ Authorize
                        </button>
                        <button type="submit"
                                name="action"
                                value="deny"
                                class="win95-btn">
                            ✗ Deny
                        </button>
                    </div>
                </form>
            </div>

            <div class="win95-statusbar flex justify-between">
                <span>OAuth 2.0 Authorization</span>
                <span>${new Date().toLocaleDateString()}</span>
            </div>
        </div>
    </div>

    <script>
        let selectedResources = new Set();
        let newResources = new Set();

        function toggleResource(checkbox, path) {
            if (checkbox.checked) {
                selectedResources.add(path);
            } else {
                selectedResources.delete(path);
            }
            updateSelectedResources();
            updateApproveButton();
            updateSelectAllButton();
        }

        function addNewResource() {
            const input = document.getElementById('newResourcePath');
            const path = input.value.trim();

            if (!path) {
                alert('Please enter a resource path');
                return;
            }

            if (path.startsWith('/') || path.includes('..')) {
                alert('Invalid path format.');
                return;
            }

            if (selectedResources.has(path) || newResources.has(path)) {
                alert('This resource is already selected');
                return;
            }

            selectedResources.add(path);
            newResources.add(path);

            const newResourcesList = document.getElementById('newResourcesList');
            const resourceDiv = document.createElement('div');
            resourceDiv.className = 'flex items-center justify-between p-1 bg-[#ffffcc] text-[10px]';
            resourceDiv.innerHTML = \`
                <span>➕ \${path} (new)</span>
                <button type="button" onclick="removeNewResource('\${path}', this.parentElement)" class="win95-btn text-[9px] py-0 px-1 min-w-0">×</button>
            \`;
            newResourcesList.appendChild(resourceDiv);

            input.value = '';
            updateSelectedResources();
            updateApproveButton();
        }

        function removeNewResource(path, element) {
            selectedResources.delete(path);
            newResources.delete(path);
            element.remove();
            updateSelectedResources();
            updateApproveButton();
        }

        function toggleSelectAll() {
            const checkboxes = document.querySelectorAll('.resource-checkbox');
            const allSelected = Array.from(checkboxes).every(cb => cb.checked);

            checkboxes.forEach(cb => {
                cb.checked = !allSelected;
                const path = cb.getAttribute('data-path');
                if (cb.checked) {
                    selectedResources.add(path);
                } else {
                    selectedResources.delete(path);
                }
            });

            updateSelectedResources();
            updateApproveButton();
            updateSelectAllButton();
        }

        function clearSelection() {
            const checkboxes = document.querySelectorAll('.resource-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = false;
                const path = cb.getAttribute('data-path');
                selectedResources.delete(path);
            });

            const newResourcesList = document.getElementById('newResourcesList');
            if (newResourcesList) newResourcesList.innerHTML = '';
            newResources.clear();
            selectedResources.clear();

            updateSelectedResources();
            updateApproveButton();
            updateSelectAllButton();
        }

        function updateSelectedResources() {
            const el = document.getElementById('selectedResources');
            if (el) el.value = JSON.stringify(Array.from(selectedResources));
        }

        function updateApproveButton() {
            const approveBtn = document.getElementById('approveBtn');
            if (approveBtn) {
                approveBtn.disabled = ${hasVariableScopes ? "selectedResources.size === 0" : "false"};
            }
        }

        function updateSelectAllButton() {
            const selectAllBtn = document.getElementById('selectAllBtn');
            const checkboxes = document.querySelectorAll('.resource-checkbox');

            if (selectAllBtn && checkboxes.length > 0) {
                const allSelected = Array.from(checkboxes).every(cb => cb.checked);
                selectAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
            }
        }

        const newResourceInput = document.getElementById('newResourcePath');
        if (newResourceInput) {
            newResourceInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addNewResource();
                }
            });
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { ...getCorsHeaders(), "Content-Type": "text/html" },
  });
}

function generateFileTree(files: FileNode[], username: string): string {
  let html = `
    <label class="win95-list-item flex items-center">
      <input type="checkbox"
             class="win95-checkbox resource-checkbox"
             data-path=""
             onchange="toggleResource(this, '')">
      <span>📁 / (Root Directory) - All files</span>
    </label>
  `;

  const userFiles = files
    .filter((f) => f.path.startsWith(`/${username}/`))
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });

  userFiles.forEach((file) => {
    const relativePath = file.path.slice(`/${username}/`.length);
    const isFolder = file.type === "folder";
    const icon = isFolder ? "📁" : "📄";

    html += `
      <label class="win95-list-item flex items-center">
        <input type="checkbox"
               class="win95-checkbox resource-checkbox"
               data-path="${relativePath}"
               onchange="toggleResource(this, '${relativePath}')">
        <span>${icon} ${relativePath}${isFolder ? "" : ` (${file.size} bytes)`}</span>
      </label>
    `;
  });

  html += `
    <div class="p-2 bg-[#c0c0c0] border-t border-gray-400">
      <div class="text-[10px] font-bold mb-1">➕ Add new resource:</div>
      <div class="flex gap-1">
        <input type="text"
               id="newResourcePath"
               placeholder="e.g., docs/notes.txt"
               class="win95-input flex-1 text-[10px]">
        <button type="button" onclick="addNewResource()" class="win95-btn text-[10px] py-0">Add</button>
      </div>
      <div id="newResourcesList" class="mt-1 space-y-1"></div>
    </div>
  `;

  if (userFiles.length === 0) {
    html += `
      <div class="p-2 text-center text-[10px] text-gray-600">
        ℹ️ No existing files. Grant access to root or add new resources above.
      </div>
    `;
  }

  return html;
}

function getScopeDescription(action: string, resource?: string): string {
  const resourceStr = resource || "all your files";
  switch (action) {
    case "read":
      return `View and download ${resourceStr}`;
    case "write":
      return `Create, modify, and delete ${resourceStr}`;
    case "append":
      return `Add content to ${resourceStr}`;
    default:
      return `${action} access to ${resourceStr}`;
  }
}
