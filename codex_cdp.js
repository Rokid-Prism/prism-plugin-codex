"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

function requireCdpRuntime() {
  return require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
}

const {
  CdpPageClient,
  DEFAULT_ACTION_TIMEOUT_MS,
  firstNonEmpty,
  sleep,
  visibleElementScript,
} = requireCdpRuntime();

const execFileAsync = promisify(execFile);

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_READY_TIMEOUT_MS = 15000;
const THREAD_SELECTION_TIMEOUT_MS = 4000;

// These vector prefixes are version-scoped Codex Desktop capabilities. They
// are deliberately preferred over localized labels so a Chinese/English UI
// switch cannot turn a remote command into a different native action.
const GOAL_ICON_PREFIX = "M9.96861 1.91681";
const PLAN_ICON_PREFIX = "M8 3.52051C9.07134";
const GOAL_EDIT_ICON_PREFIX = "M4.33496 11";
const GOAL_PAUSE_ICON_PREFIX = "M10.625 7.91667";
const GOAL_RESUME_ICON_PREFIX = "M7.96582 7.81836";
const GOAL_CLEAR_ICON_PREFIX = "M10.6299 1.33496";

function goalPlanDOMHelpersSource() {
  return `
    const prismVisible = (element) => {
      const rect = element && element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const prismFirstPath = (element) => String(element?.querySelector('svg path')?.getAttribute('d') || '');
    const prismHasIcon = (element, prefix) => prismFirstPath(element).startsWith(prefix);
    const prismGoalCard = () => {
      const goalIcons = [...document.querySelectorAll('svg')]
        .filter(prismVisible)
        .filter((svg) => String(svg.querySelector('path')?.getAttribute('d') || '').startsWith(${JSON.stringify(GOAL_ICON_PREFIX)}));
      const cards = [];
      for (const icon of goalIcons) {
        for (let node = icon.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth += 1) {
          const buttons = [...node.querySelectorAll('button')].filter(prismVisible);
          const hasEdit = buttons.some((button) => prismHasIcon(button, ${JSON.stringify(GOAL_EDIT_ICON_PREFIX)}));
          const hasClear = buttons.some((button) => prismHasIcon(button, ${JSON.stringify(GOAL_CLEAR_ICON_PREFIX)}));
          const hasPause = buttons.some((button) => prismHasIcon(button, ${JSON.stringify(GOAL_PAUSE_ICON_PREFIX)}));
          const hasResume = buttons.some((button) => prismHasIcon(button, ${JSON.stringify(GOAL_RESUME_ICON_PREFIX)}));
          // The compact Goal card omits Edit until its expanded view is open.
          // Clear plus any lifecycle control remains a unique durable Goal
          // signature, while slash-command rows contain none of these controls.
          if (hasClear && (hasEdit || hasPause || hasResume)) {
            cards.push(node);
            break;
          }
        }
      }
      const unique = cards.filter((card, index) => cards.indexOf(card) === index);
      return unique.length === 1 ? unique[0] : null;
    };
    const prismGoalControl = (kind) => {
      const card = prismGoalCard();
      if (!card) return null;
      const prefix = {
        edit: ${JSON.stringify(GOAL_EDIT_ICON_PREFIX)},
        pause: ${JSON.stringify(GOAL_PAUSE_ICON_PREFIX)},
        resume: ${JSON.stringify(GOAL_RESUME_ICON_PREFIX)},
        clear: ${JSON.stringify(GOAL_CLEAR_ICON_PREFIX)},
      }[kind];
      if (!prefix) return null;
      const candidates = [...card.querySelectorAll('button')]
        .filter(prismVisible)
        .filter((button) => prismHasIcon(button, prefix));
      return candidates.length === 1 ? candidates[0] : null;
    };
    const prismGoalState = () => {
      const card = prismGoalCard();
      const composerRoot = document.querySelector('[data-codex-composer-root]');
      if (!card) return { status: 'none', objective: '', available: Boolean(prismVisible(composerRoot)) };
      const paused = Boolean(prismGoalControl('resume'));
      // Current Codex renders the goal summary as its own button in the card:
      // status / objective / elapsed-time. It is not a div, and a slash-command
      // row never has the edit-and-clear card ownership checked above.
      const summaryButtons = [...card.querySelectorAll('button')].filter((button) => {
        const directSpans = [...button.children].filter((child) => child.tagName === 'SPAN');
        return prismVisible(button) && directSpans.length === 3;
      });
      const spans = summaryButtons.length === 1
        ? [...summaryButtons[0].children].filter((child) => child.tagName === 'SPAN')
        : [];
      // The goal row is structurally status / objective / elapsed-time. Read
      // the middle value so neither translated status nor the timer leaks into
      // the objective projected to Prism clients.
      const objectiveSpan = spans.length >= 3 ? spans[spans.length - 2] : null;
      const directObjective = objectiveSpan
        ? [...(objectiveSpan.childNodes || [])]
          .filter((node) => node && node.nodeType === 3)
          .map((node) => String(node.nodeValue || ''))
          .join('')
          .trim()
        : '';
      const objective = directObjective || String(objectiveSpan?.innerText || objectiveSpan?.textContent || '').trim();
      return {
        status: paused ? 'paused' : 'running',
        objective,
        available: true,
        actions: {
          edit: Boolean(prismGoalControl('edit')),
          pause: Boolean(prismGoalControl('pause')),
          resume: Boolean(prismGoalControl('resume')),
          clear: Boolean(prismGoalControl('clear')),
        },
      };
    };
    const prismPlanIndicator = () => {
      const composerRoot = document.querySelector('[data-codex-composer-root]');
      if (!prismVisible(composerRoot)) return null;
      const candidates = [...composerRoot.querySelectorAll('button')]
        .filter(prismVisible)
        .filter((button) => !button.closest('[data-list-navigation-item="true"], [role="menu"], [role="listbox"]'))
        .filter((button) => prismHasIcon(button, ${JSON.stringify(PLAN_ICON_PREFIX)}));
      return candidates.length === 1 ? candidates[0] : null;
    };
    const prismGoalPlanState = () => ({
      plan_mode: { enabled: Boolean(prismPlanIndicator()), available: Boolean(prismVisible(document.querySelector('[data-codex-composer-root]'))) },
      goal: prismGoalState(),
    });
  `;
}

function goalComposerSubmitElementExpression() {
  return `(() => {
    const visible = (element) => {
      const rect = element && element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const enabled = (element) => Boolean(
      element
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true',
    );
    const fiberFor = (element) => {
      const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const isNativeSubmit = (element) => {
      let hasPrimaryContract = false;
      let ownerCount = 0;
      for (let current = fiberFor(element), depth = 0; current && depth < 16; current = current.return, depth += 1) {
        const props = current.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        if (
          typeof props.isLoading === 'boolean'
          && typeof props.disabled === 'boolean'
          && typeof props.ariaLabel === 'string'
          && props.Icon
          && typeof props.onClick === 'function'
        ) hasPrimaryContract = true;
        if (
          typeof props.submitButtonMode === 'string'
          && typeof props.isResponseInProgress === 'boolean'
          && typeof props.isQueueingEnabled === 'boolean'
          && typeof props.submitDisabled === 'boolean'
        ) ownerCount += 1;
      }
      return hasPrimaryContract && ownerCount === 1;
    };
    const root = document.querySelector('[data-codex-composer-root]');
    if (!visible(root)) return null;
    // The Goal command replaces the regular footer navigation with its own
    // editor. Its confirmation is still the normal uniquely-owned Composer
    // primary button, not the Goal mode-toggle that opened the editor.
    const candidates = [...root.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter(enabled)
      .filter((button) => !button.closest('[data-list-navigation-item="true"], [role="menu"], [role="listbox"]'))
      .filter((button) => button.getAttribute('aria-haspopup') !== 'menu')
      .filter(isNativeSubmit);
    return candidates.length === 1 ? candidates[0] : null;
  })()`;
}

function composerEditableElementExpression() {
  return `(() => {
    const visible = (element) => {
      const rect = element && element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const root = document.querySelector('[data-codex-composer-root]');
    if (!visible(root)) return null;
    const editableCandidates = [
      ...root.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"]'),
    ]
      .filter(visible)
      .filter((element) => element.getAttribute('aria-disabled') !== 'true' && !element.disabled)
      .filter((element) => !element.closest('[role="menu"], [role="listbox"]'));
    // Goal mode mounts a real contenteditable inside the legacy Composer
    // wrapper. Prefer that editor so the wrapper and child do not make an
    // otherwise unambiguous input look ambiguous.
    if (editableCandidates.length === 1) return editableCandidates[0];
    if (editableCandidates.length > 1) return null;
    const legacyCandidates = [...root.querySelectorAll('[data-codex-composer]')]
      .filter(visible)
      .filter((element) => element.getAttribute('aria-disabled') !== 'true' && !element.disabled)
      .filter((element) => !element.closest('[role="menu"], [role="listbox"]'));
    return legacyCandidates.length === 1 ? legacyCandidates[0] : null;
  })()`;
}

// In current Codex Desktop the normal Composer marker and the newer root can
// be siblings. Prefer the real Composer marker for normal message operations;
// using the root first makes its child query miss that sibling and falsely
// report that no editable input exists. Goal-specific UI can still fall back
// to the root when the regular marker is intentionally replaced.
function composerContainerElementExpression() {
  return `(() => {
    const visible = (element) => {
      const rect = element && element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const legacy = document.querySelector('[data-codex-composer="true"], [data-codex-composer]');
    if (visible(legacy)) return legacy;
    const root = document.querySelector('[data-codex-composer-root]');
    return visible(root) ? root : null;
  })()`;
}

function composerPrimaryActionElementExpression() {
  return `(() => {
    const visible = (element) => {
      const rect = element && element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const enabled = (element) => Boolean(
      element
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true',
    );
    const composer = ${composerContainerElementExpression()};
    if (!composer) return null;
    // Onboarding and approval forms can use a composer-shaped container and
    // inherit Composer Fiber state. They are not a chat input without an
    // editable surface, so never expose their submit button to remote control.
    const editableSurfaces = [
      ...(composer.matches('textarea, input:not([type="hidden"]), [contenteditable="true"]') ? [composer] : []),
      ...composer.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"]'),
    ].filter(visible).filter((element) => enabled(element) && !element.readOnly);
    if (editableSurfaces.length === 0) return null;
    const fiberFor = (element) => {
      const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const hasComposerPrimaryButtonContract = (element) => {
      for (let current = fiberFor(element), depth = 0; current && depth < 16; current = current.return, depth += 1) {
        const props = current.memoizedProps;
        if (
          props && typeof props === 'object'
          && typeof props.isLoading === 'boolean'
          && typeof props.disabled === 'boolean'
          && typeof props.ariaLabel === 'string'
          && props.Icon
          && typeof props.onClick === 'function'
        ) return true;
      }
      return false;
    };
    const isComposerPrimaryAction = (element) => {
      if (!hasComposerPrimaryButtonContract(element)) return false;
      let ownerCount = 0;
      for (let current = fiberFor(element), depth = 0; current && depth < 16; current = current.return, depth += 1) {
        const props = current.memoizedProps;
        if (
          props && typeof props === 'object'
          && typeof props.submitButtonMode === 'string'
          && typeof props.isResponseInProgress === 'boolean'
          && typeof props.isQueueingEnabled === 'boolean'
          && typeof props.submitDisabled === 'boolean'
        ) ownerCount += 1;
      }
      return ownerCount === 1;
    };
    for (let footer = composer; footer; footer = footer.parentElement) {
      if (footer.querySelectorAll('[data-composer-navigation-target]').length === 0) continue;
      const candidates = [...footer.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(enabled)
        .filter((element) => !element.hasAttribute('data-composer-navigation-target'))
        .filter((element) => String(element.getAttribute('aria-haspopup') || '').toLowerCase() !== 'menu');
      const actionCandidates = candidates.filter(isComposerPrimaryAction);
      return actionCandidates.length === 1 ? actionCandidates[0] : null;
    }
    return null;
  })()`;
}

// Codex attachment cards have changed DOM shape across Desktop builds.  The
// file name is the native, locale-independent payload identity; inspect it
// only inside the composer surface, never in the transcript or sidebar.
function composerAttachmentStateSource() {
  return `
    const prismComposerAttachmentState = (expectedName = '') => {
      const visible = (element) => {
        const rect = element && element.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const normalized = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const composer = ${composerContainerElementExpression()};
      if (!composer) return { present: false, matched: false, reason: 'composer_unavailable', candidates: [] };
      // Codex renders the attachment tray as a sibling of the Composer footer
      // in current Desktop builds. It is therefore intentionally queried from
      // the document, while each card has a stable structural class.
      const cards = [...document.querySelectorAll('.composer-attachment-surface')].filter(visible);
      const candidates = [];
      const seen = new Set();
      const addCandidate = (value) => {
        const name = normalized(value);
        if (!name || seen.has(name)) return;
        seen.add(name);
        candidates.push(name.slice(0, 512));
      };
      const elements = [
        ...cards.flatMap((card) => [card, ...card.querySelectorAll('*')]),
      ];
      for (const element of elements) {
        if (!visible(element)) continue;
        addCandidate(element.getAttribute('data-attachment-name'));
        addCandidate(element.getAttribute('data-file-name'));
        addCandidate(element.getAttribute('aria-label'));
        addCandidate(element.getAttribute('title'));
        // Cards in some Codex releases expose the filename only as nested
        // text, so read it only within a native attachment surface.
        if (element.classList && element.classList.contains('composer-attachment-surface')) {
          addCandidate(element.innerText || element.textContent);
        }
      }
      const expected = normalized(expectedName);
      const matched = Boolean(expected) && candidates.some((candidate) => candidate === expected || candidate.includes(expected));
      return {
        present: cards.length > 0,
        matched,
        has_attachment_surface: cards.length > 0,
        candidates: candidates.slice(0, 16),
      };
    };
  `;
}

// Codex exposes the composer action's state on the nearest composer Fiber.
// Keep the Desktop semantic contract separate from localized visible labels:
// a missing or ambiguous owner is unavailable, never guessed.
function composerPrimaryActionFactsSource() {
  return `
    const prismComposerPrimaryActionFacts = () => {
      const visible = (element) => {
        const rect = element && element.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const enabled = (element) => Boolean(
        element
        && !element.disabled
        && element.getAttribute('aria-disabled') !== 'true',
      );
      const fiberFor = (element) => {
        const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        return key ? element[key] : null;
      };
      const hasComposerPrimaryButtonContract = (element) => {
        for (let current = fiberFor(element), depth = 0; current && depth < 16; current = current.return, depth += 1) {
          const props = current.memoizedProps;
          if (
            props && typeof props === 'object'
            && typeof props.isLoading === 'boolean'
            && typeof props.disabled === 'boolean'
            && typeof props.ariaLabel === 'string'
            && props.Icon
            && typeof props.onClick === 'function'
          ) return true;
        }
        return false;
      };
      const textOf = (element) => String(element && (element.innerText || element.textContent) || '').replace(/\s+/g, ' ').trim();
      const composer = ${composerContainerElementExpression()};
      if (!composer) return { usable: false, reason: 'composer_unavailable' };
      // A Composer-shaped root can temporarily contain an internal onboarding
      // form. Its inherited Fiber props must not project it as a running chat.
      const editableSurfaces = [
        ...(composer.matches('textarea, input:not([type="hidden"]), [contenteditable="true"]') ? [composer] : []),
        ...composer.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"]'),
      ].filter(visible).filter((element) => enabled(element) && !element.readOnly);
      if (editableSurfaces.length === 0) return { usable: false, reason: 'composer_input_unavailable' };
      // In current Codex builds the owner still exposes the submit/stop state,
      // but its hasMessageContent property can stay false after a native CDP
      // input. The visible editable surface and attachment row are the native payload
      // surface that the same submit button operates on, so use them only for
      // payload presence while retaining Fiber facts for action semantics.
      ${composerAttachmentStateSource()}
      const attachmentState = prismComposerAttachmentState();
      const hasNativePayload = editableSurfaces.some((element) => Boolean(textOf(element))) || attachmentState.present === true;
      let footer = null;
      for (let node = composer; node; node = node.parentElement) {
        if ([...node.querySelectorAll('[data-composer-navigation-target]')].some(visible)) {
          footer = node;
          break;
        }
      }
      if (!footer) return { usable: false, reason: 'composer_footer_unavailable' };
      const candidates = [...footer.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter((element) => !element.hasAttribute('data-composer-navigation-target'))
        .filter((element) => String(element.getAttribute('aria-haspopup') || '').toLowerCase() !== 'menu');
      // Other composer actions (for example dictation) can be siblings of the
      // actual submit button. Select only the button whose Fiber ancestry owns
      // the complete submit state and the primary-button contract; visible
      // labels, button order, and CSS classes are not a stable contract.
      const actionCandidates = [];
      for (const element of candidates) {
        if (!hasComposerPrimaryButtonContract(element)) continue;
        const owners = [];
        for (let current = fiberFor(element), depth = 0; current && depth < 16; current = current.return, depth += 1) {
          const props = current.memoizedProps;
          if (!props || typeof props !== 'object') continue;
          if (
            typeof props.submitButtonMode === 'string'
            && typeof props.isResponseInProgress === 'boolean'
            && typeof props.isQueueingEnabled === 'boolean'
            && typeof props.submitDisabled === 'boolean'
          ) {
            owners.push(props);
          }
        }
        if (owners.length === 1) actionCandidates.push({ element, owner: owners[0] });
      }
      if (actionCandidates.length !== 1) return { usable: false, reason: 'composer_action_owner_ambiguous' };
      const { element, owner } = actionCandidates[0];
      const mode = String(owner.submitButtonMode || '').trim().toLowerCase();
      return {
        usable: Boolean(mode),
        enabled: enabled(element),
        mode,
        response_in_progress: owner.isResponseInProgress === true,
        queueing_enabled: owner.isQueueingEnabled === true,
        submit_disabled: owner.submitDisabled === true,
        stopping: owner.isStopping === true,
        resume_pending: owner.isResumePending === true,
        interaction_blocked: owner.isInteractionBlocked === true,
        has_message_content: owner.hasMessageContent === true || hasNativePayload,
      };
    };
  `;
}

function composerPrimaryActionRuntimeExpression() {
  return `(() => {
    ${composerPrimaryActionFactsSource()}
    const facts = prismComposerPrimaryActionFacts();
    return facts && typeof facts === 'object' ? facts : { usable: false, reason: 'composer_action_unavailable' };
  })()`;
}

function composerStopClickExpression() {
  return `(() => {
    ${composerPrimaryActionFactsSource()}
    const facts = prismComposerPrimaryActionFacts();
    if (!facts || facts.usable !== true || facts.enabled !== true || facts.response_in_progress !== true || facts.mode !== 'stop') {
      return { ok: false, reason: 'interrupt_control_unavailable' };
    }
    const visible = (element) => {
      const rect = element && element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const composer = ${composerContainerElementExpression()};
    let footer = null;
    for (let node = composer; node; node = node.parentElement) {
      if ([...node.querySelectorAll('[data-composer-navigation-target]')].some(visible)) {
        footer = node;
        break;
      }
    }
    if (!footer) return { ok: false, reason: 'interrupt_control_unavailable' };
    const actions = [...footer.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter((element) => !element.hasAttribute('data-composer-navigation-target'))
      .filter((element) => String(element.getAttribute('aria-haspopup') || '').toLowerCase() !== 'menu')
      .filter((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    if (actions.length !== 1) return { ok: false, reason: 'interrupt_control_unavailable' };
    const action = actions[0];
    action.focus && action.focus();
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
    const down = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
    const up = { bubbles: true, cancelable: true, button: 0, buttons: 0 };
    try { action.dispatchEvent(new PointerEvent('pointerdown', pointer)); } catch {}
    try { action.dispatchEvent(new MouseEvent('mousedown', down)); } catch {}
    try { action.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 })); } catch {}
    try { action.dispatchEvent(new MouseEvent('mouseup', up)); } catch {}
    try { action.dispatchEvent(new MouseEvent('click', up)); } catch {}
    return { ok: true };
  })()`;
}

function approvalDOMHelpersSource() {
  return `
    // Approval discovery deliberately uses Codex's version-scoped structural
    // contract and React callback identity. Visible labels are presentation
    // data only: a locale or copy change must never change a remote decision.
    const approvalSurfaceSelector = [
      '[data-codex-approval-surface="true"]',
      '[data-testid*="approval" i]',
      '[data-testid*="permission" i]',
      '[data-prism-approval-surface="true"]',
    ].join(', ');
    const approvalFiberFor = (element) => {
      const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const approvalPropsFor = (element) => {
      const directKey = element && Object.keys(element).find((name) => name.startsWith('__reactProps$'));
      if (directKey && element[directKey] && typeof element[directKey] === 'object') return element[directKey];
      const fiber = approvalFiberFor(element);
      return fiber && fiber.memoizedProps && typeof fiber.memoizedProps === 'object' ? fiber.memoizedProps : null;
    };
    const approvalActionHandler = (element) => {
      const props = approvalPropsFor(element);
      return props && typeof props.onClick === 'function' ? props.onClick : null;
    };
    const approvalRegistry = (() => {
      const key = Symbol.for('prism.codex.approval-interactions.v1');
      const current = window[key];
      if (current && current.actions instanceof WeakMap && typeof current.next === 'number') return current;
      const created = { actions: new WeakMap(), next: 1 };
      window[key] = created;
      return created;
    })();
    const approvalActionToken = (handler) => {
      if (typeof handler !== 'function') return '';
      let token = approvalRegistry.actions.get(handler);
      if (!token) {
        token = String(approvalRegistry.next++);
        approvalRegistry.actions.set(handler, token);
      }
      return token;
    };
    const visibleApprovalButtons = (scope) => [...scope.querySelectorAll('button, [role="button"]')]
      .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .filter((el) => !el.hasAttribute('aria-haspopup'))
      .filter((el) => Boolean(approvalActionHandler(el)));
    const approvalActionGroup = (surface) => {
      const candidates = [surface, ...surface.querySelectorAll('[role="group"], form, [data-codex-approval-actions="true"]')];
      const groups = candidates.map((candidate) => visibleApprovalButtons(candidate))
        .filter((actions) => actions.length >= 2 && actions.length <= 4)
        .map((actions) => ({
          actions,
          signature: actions.map((action) => approvalActionToken(approvalActionHandler(action))).join('|'),
        }));
      const signatures = [...new Set(groups.map((group) => group.signature).filter(Boolean))];
      return signatures.length === 1 ? groups.find((group) => group.signature === signatures[0])?.actions || null : null;
    };
    const findApprovalActionSurface = () => {
      const candidates = [...document.querySelectorAll(approvalSurfaceSelector)].filter(visible);
      const matched = candidates.filter((surface) => Boolean(approvalActionGroup(surface)));
      return matched.length === 1 ? matched[0] : null;
    };
    const findApprovalDialog = () => findApprovalActionSurface();
    const approvalActionElements = (dialog) => dialog ? (approvalActionGroup(dialog) || []) : [];
    const approvalInputElement = (dialog) => dialog
      ? [...dialog.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"]')]
        .find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') || null
      : null;
    const approvalActionId = (el) => {
      const token = approvalActionToken(approvalActionHandler(el));
      return token ? 'desktop:react:' + token : '';
    };
    const approvalActionMatches = (requestedID, el) => approvalActionId(el) === requestedID;
    const approvalActionRequiresInput = (el, input) => {
      if (!input) return false;
      if ((el.getAttribute('data-requires-input') || '').toLowerCase() === 'true') return true;
      const controls = (el.getAttribute('aria-controls') || '').trim();
      if (controls && input.id && controls.split(/\\s+/).includes(input.id)) return true;
      const form = input.closest('form');
      if (!form) return false;
      const buttonForm = el.closest('form');
      const explicitForm = (el.getAttribute('form') || '').trim();
      const submitsForm = !el.hasAttribute('type') || (el.getAttribute('type') || '').toLowerCase() === 'submit';
      return submitsForm && (buttonForm === form || (explicitForm && form.id === explicitForm));
    };
    const approvalInputDescriptor = (input) => {
      if (!input) return null;
      const label = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null;
      return {
        enabled: true,
        kind: input.tagName === 'TEXTAREA' || input.getAttribute('contenteditable') === 'true' ? 'text' : (input.getAttribute('type') || 'text'),
        label: textOf(label) || (input.getAttribute('aria-label') || '').trim(),
        placeholder: (input.getAttribute('placeholder') || '').trim(),
        multiline: input.tagName === 'TEXTAREA' || input.getAttribute('contenteditable') === 'true',
      };
    };
    const collectApproval = (threadId = '') => {
      const dialog = findApprovalDialog();
      if (!dialog) return null;
      const titleEl = dialog.querySelector('h1, h2, h3, [data-testid="dialog-title"], strong');
      const codeEl = dialog.querySelector('code, pre, kbd');
      const input = approvalInputElement(dialog);
      const text = textOf(dialog);
      const title = textOf(titleEl) || '等待审批';
      const approvalId = threadId ? ('live:' + threadId) : 'live:current';
      const actions = approvalActionElements(dialog).map((el, index) => {
        const label = textOf(el) || (el.getAttribute('aria-label') || '').trim() || ('Action ' + (index + 1));
        const variant = [el.getAttribute('data-variant'), el.className].join(' ').toLowerCase();
        const style = /danger|destructive/.test(variant)
          ? 'danger'
          : (/primary|default/.test(variant) || index === 0 ? 'primary' : 'secondary');
        return {
          id: approvalActionId(el),
          label,
          style,
          requires_input: approvalActionRequiresInput(el, input),
          available: true,
        };
      });
      return {
        id: approvalId,
        approval_request_id: approvalId,
        title,
        summary: title,
        description: text,
        command: textOf(codeEl),
        method: 'desktop.live.dialog',
        status: 'waiting_approval',
        source: 'desktop_live',
        actions,
        input: approvalInputDescriptor(input),
      };
    };
  `;
}

function queueDOMHelpersSource() {
  return `
    const queueVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const queueText = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
    const queueFiber = (el) => {
      const key = el && Object.keys(el).find((name) => name.startsWith('__reactFiber$'));
      return key ? el[key] : null;
    };
    const queueMessageMeta = (el) => {
      for (let node = el; node; node = node.parentElement) {
        // Codex currently nests the queue item identity below animation and
        // portal wrappers. Bound the walk without cutting off its messageId.
        for (let fiber = queueFiber(node), depth = 0; fiber && depth < 32; fiber = fiber.return, depth += 1) {
          const props = fiber.memoizedProps;
          if (!props || typeof props !== 'object') continue;
          const id = String(props.messageId || props.message_id || '').trim();
          if (!id) continue;
          return {
            id,
            content: String(props.messageText || props.message_text || '').trim(),
            queueingEnabled: props.isQueueingEnabled === true,
          };
        }
      }
      return null;
    };
    const queueItemCarriers = () => {
      const footer = document.querySelector('[data-thread-scroll-footer="true"]');
      if (!footer || !queueVisible(footer)) return [];
      return [...footer.querySelectorAll('p')]
        .filter(queueVisible)
        .map((el) => ({ el, meta: queueMessageMeta(el) }))
        .filter((entry) => Boolean(entry.meta?.id && entry.meta.queueingEnabled));
    };
    const queueItemIDForElement = (el) => {
      const ids = new Set();
      for (let node = el; node; node = node.parentElement) {
        const meta = queueMessageMeta(node);
        if (meta?.id) ids.add(meta.id);
      }
      return ids.size === 1 ? [...ids][0] : '';
    };
    const queueMenuTriggers = (root, itemID) => [...root.querySelectorAll('button, [role="button"]')]
      .filter(queueVisible)
      .filter((el) => (el.getAttribute('aria-haspopup') || '').toLowerCase() === 'menu')
      .filter((el) => queueItemIDForElement(el) === itemID);
    const queueNamedDirectActions = (root, itemID) => [...root.querySelectorAll('button, [role="button"]')]
      .filter(queueVisible)
      .filter((el) => (el.getAttribute('aria-haspopup') || '').toLowerCase() !== 'menu')
      .filter((el) => queueItemIDForElement(el) === itemID)
      .filter((el) => Boolean(queueRemoteActionDescriptor(el, 'item.direct')?.label));
    const queueItemRootForCarrier = (carrier, itemID) => {
      for (let root = carrier, depth = 0; root && depth < 12; root = root.parentElement, depth += 1) {
        const matchingCarriers = [...root.querySelectorAll('p')]
          .filter(queueVisible)
          .filter((el) => queueMessageMeta(el)?.id === itemID);
        // Only publish controls whose own Fiber ancestry resolves to this
        // exact native message. A larger visual wrapper can also contain the
        // sidebar or navigation controls and is never a queue-item scope.
        if (matchingCarriers.length === 1) {
          const direct = queueNamedDirectActions(root, itemID);
          const triggers = queueMenuTriggers(root, itemID);
          if (direct.length === 0 && triggers.length === 0) continue;
          return { root, trigger: triggers.length === 1 ? triggers[0] : null };
        }
      }
      return null;
    };
    const queueActionFingerprint = (el, scope = '', position = -1) => {
      if (!el) return '';
      const attrs = {};
      for (const name of ['data-action', 'data-value', 'data-testid', 'name', 'type', 'role']) {
        const value = String(el.getAttribute(name) || '').trim();
        if (value) attrs[name] = value;
      }
      const handlers = queueActionHandlerSource(el)
        .split('\\n')
        .filter(Boolean)
        .map((source) => {
          let hash = 0xcbf29ce484222325n;
          for (const char of source) {
            hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
          }
          return hash.toString(16).padStart(16, '0');
        });
      if (Object.keys(attrs).length === 0 && handlers.length === 0) return '';
      // The relative position is scoped to one exact queue item/menu. It is
      // verified again before click and never inferred from the visible label.
      const source = JSON.stringify({ scope, position, attrs, handlers });
      let hash = 0xcbf29ce484222325n;
      for (const char of source) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
      }
      return hash.toString(16).padStart(16, '0');
    };
    const queueActionDescriptor = (el, scope, position = -1) => {
      const label = queueText(el) || String(el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const fingerprint = queueActionFingerprint(el, scope, position);
      if (!fingerprint) return null;
      return {
        id: 'queue.' + scope + '.' + fingerprint,
        label,
        available: !(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      };
    };
    const queueActionHandlerSource = (el) => {
      const sources = [];
      // Portal menus can put the action owner well above the row's immediate
      // Fiber parent. The owner is still scoped by the exact queue trigger and
      // revalidated immediately before execution.
      for (let fiber = queueFiber(el), depth = 0; fiber && depth < 32; fiber = fiber.return, depth += 1) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        for (const key of ['onClick', 'onSelect', 'onPress', 'onAction']) {
          if (typeof props[key] === 'function') sources.push(String(props[key]));
        }
      }
      return sources.join('\\n');
    };
    const queueDesktopOnlyAction = (source) => /(?:openSideChat|open_in_browser_bridge|openExternal|window\\.open|location\\.(?:assign|replace|href)|clipboard|showOpenDialog|showSaveDialog|dispatchHostMessage|startNewConversation|navigate|router\\.|history\\.(?:push|replace))/i.test(source);
    const queueMenuIconIdentity = (el) => {
      const paths = [...(el ? el.querySelectorAll('svg path') : [])]
        .map((path) => String(path.getAttribute('d') || '').trim())
        .filter(Boolean);
      if (paths.length !== 1 && paths.length !== 2) return '';
      // Codex does not expose an action ID or semantic handler for these rows.
      // Treat the concrete vector identity as a version-scoped capability. An
      // unknown icon is deliberately not exposed to Mobile.
      if (paths.length === 1 && paths[0].startsWith('M11.7313 4.20472C13.1489')) return 'edit_message';
      if (paths.length === 2 && paths[0].startsWith('M3.165 10c0-3.51') && paths[1].startsWith('M10 6.335A')) return 'desktop_side_chat';
      if (paths.length === 1 && paths[0].startsWith('M2.66797 11V3.33301')) return 'close_queue';
      return '';
    };
    const queueMobileMenuAction = (el) => {
      const identity = queueMenuIconIdentity(el);
      return identity === 'edit_message' || identity === 'close_queue';
    };
    const queueRemoteActionDescriptor = (el, scope, position = -1) => {
      const action = queueActionDescriptor(el, scope, position);
      const source = queueActionHandlerSource(el);
      if (!action || !source || queueDesktopOnlyAction(source)) return null;
      // Menu rows have no stable DOM/Fiber action ID. Restrict them to the
      // two vector identities proven to be remote-safe. Direct actions retain
      // their normal handler-based proof.
      if (scope === 'item.menu' && !queueMobileMenuAction(el)) return null;
      return action;
    };
    const queueDirectActionElements = (itemID) => {
      const entry = queueItemEntries().find((item) => item.id === itemID);
      if (!entry) return [];
      // The opaque action id includes its item-local position. Reuse the
      // exact candidate sequence used by queueItemEntries(); a broader DOM
      // walk can insert unrelated direct buttons and make the same action
      // appear stale between snapshot and click.
      return queueNamedDirectActions(entry.root, itemID);
    };
    const queueItemEntries = () => {
      const byID = new Map();
      const carriers = queueItemCarriers();
      for (const { el, meta } of carriers) {
        if (!meta || !meta.id || byID.has(meta.id)) continue;
        const location = queueItemRootForCarrier(el, meta.id);
        if (!location) continue;
        const direct = queueNamedDirectActions(location.root, meta.id)
          .map((el, index) => queueRemoteActionDescriptor(el, 'item.direct', index))
          .filter((action) => action && action.label);
        byID.set(meta.id, {
          id: meta.id,
          content: meta.content,
          actions: direct,
          has_more_actions: Boolean(location.trigger),
          root: location.root,
          trigger: location.trigger,
        });
      }
      return [...byID.values()];
    };
    const queueItemDescriptors = () => queueItemEntries()
      .map(({ id, content, actions, has_more_actions }) => ({ id, content, actions, has_more_actions }));
    const queueMenuTrigger = (itemID) => (queueItemEntries().find((item) => item.id === itemID) || {}).trigger || null;
    const queueMenuForItem = (itemID) => {
      const trigger = queueMenuTrigger(itemID);
      if (!trigger) return null;
      const menuID = String(trigger.getAttribute('aria-controls') || '').trim();
      const menus = [
        menuID ? document.getElementById(menuID) : null,
        ...[...document.querySelectorAll('[role="menu"], [role="listbox"]')]
          .filter((menu) => String(menu.getAttribute('aria-labelledby') || '').trim() === String(trigger.id || '').trim()),
      ].filter((menu, index, all) => menu && queueVisible(menu) && all.indexOf(menu) === index);
      return menus.length === 1 ? menus[0] : null;
    };
    const queueMenuActionElements = (itemID) => {
      const menu = queueMenuForItem(itemID);
      if (!menu) return [];
      const candidates = [...menu.querySelectorAll('[role="menuitem"], [role="option"], button')]
        .filter(queueVisible)
        .filter((el) => el.closest('[role="menu"], [role="listbox"]') === menu);
      // Some Codex builds use an actionable menuitem around an actionable
      // button. Keep the deepest action owner so one native row cannot become
      // two unstable opaque options.
      return candidates.filter((element) => !candidates.some((candidate) =>
        candidate !== element
        && element.contains(candidate)
        && queueActionHandlerSource(candidate)
      ));
    };
    const queueVisibleMenuRows = (itemID) => {
      const menu = queueMenuForItem(itemID);
      if (!menu) return [];
      const elements = queueMenuActionElements(itemID);
      if (!elements.length) return [];
      return elements
        .map((el, index) => {
          const action = queueRemoteActionDescriptor(el, 'item.menu', index);
          return action ? {
            optionId: action.id,
            label: action.label,
            disabled: action.available === false,
          } : null;
        })
        .filter(Boolean);
    };
    const queueMenuDiagnostics = (itemID) => {
      const menu = queueMenuForItem(itemID);
      if (!menu) return { menu_found: false, candidates: [] };
      const candidates = [...menu.querySelectorAll('[role="menuitem"], [role="option"], button')]
        .filter(queueVisible)
        .filter((el) => el.closest('[role="menu"], [role="listbox"]') === menu);
      return {
        menu_found: true,
        candidates: candidates.map((el, index) => {
          const source = queueActionHandlerSource(el);
          const action = queueRemoteActionDescriptor(el, 'item.menu', index);
          return {
            index,
            role: String(el.getAttribute('role') || '').trim(),
            tag: String(el.tagName || '').toLowerCase(),
            has_handler: Boolean(source),
            desktop_only: Boolean(source && queueDesktopOnlyAction(source)),
            nested_remote_handler: Boolean([...el.querySelectorAll('*')].some((child) => queueActionHandlerSource(child))),
            published: Boolean(action),
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          };
        }),
      };
    };
    const queueLevelActionElements = () => {
      const items = queueItemEntries();
      if (!items.length) return [];
      const footer = document.querySelector('[data-thread-scroll-footer="true"]');
      if (!footer || !queueVisible(footer)) return [];
      return [...footer.querySelectorAll('button, [role="button"]')]
        .filter(queueVisible)
        .filter((el) => !items.some((item) => item.root.contains(el)))
        .filter((el) => {
          const text = queueText(el);
          for (let node = el.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
            const fiber = queueFiber(node);
            for (let current = fiber, fiberDepth = 0; current && fiberDepth < 32; current = current.return, fiberDepth += 1) {
              const props = current.memoizedProps;
              if (props && typeof props === 'object' && props.isQueueingEnabled === true && Array.isArray(props.messages) && text) return true;
            }
          }
          return false;
        });
    };
    const queueLevelActions = () => queueLevelActionElements()
      .map((el, index) => queueRemoteActionDescriptor(el, 'queue', index))
      .filter((action) => action && action.label);
  `;
}

function foregroundThreadIdExpression() {
  return `(() => {
    const normalizeThreadId = (value) => {
      const text = String(value || '').trim();
      if (!text) return '';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
        return text;
      }
      const match = text.match(/(^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      return match && match[2] ? match[2] : text;
    };
    const foreground = document.querySelector('[data-above-composer-conversation-id]');
    return normalizeThreadId(foreground && foreground.getAttribute('data-above-composer-conversation-id'));
  })()`;
}

function visiblePermissionMenuRowsExpression() {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const normalize = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/\\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
    const fingerprint = (value) => {
      let hash = 0xcbf29ce484222325n;
      for (const char of normalize(value)) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
      }
      return hash.toString(16).padStart(16, '0');
    };
    const trigger = document.querySelector('[data-composer-navigation-target="permissions"]');
    if (!trigger) return [];
    const isMenuRow = (el) => ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option']
      .includes(String(el && el.getAttribute('role') || '').toLowerCase());
    const isCurrent = (el) => {
      const selected = (node) => node && (
        node.getAttribute('aria-checked') === 'true' ||
        node.getAttribute('aria-selected') === 'true' ||
        node.getAttribute('aria-current') === 'true' ||
        node.getAttribute('data-state') === 'checked' ||
        node.getAttribute('data-state') === 'selected' ||
        node.getAttribute('data-checked') === 'true' ||
        node.getAttribute('data-selected') === 'true'
      );
      return selected(el) || Boolean(el && el.querySelector(
        '[aria-checked="true"], [aria-selected="true"], [aria-current="true"], ' +
        '[data-state="checked"], [data-state="selected"], [data-checked="true"], [data-selected="true"]'
      ));
    };
    const menuID = String(trigger.getAttribute('aria-controls') || '').trim();
    const menus = [
      menuID ? document.getElementById(menuID) : null,
      ...[...document.querySelectorAll('[role="menu"]')].filter((menu) =>
        String(menu.getAttribute('aria-labelledby') || '').trim() === String(trigger.id || '').trim()
      ),
    ].filter((menu, index, all) => menu && visible(menu) && all.indexOf(menu) === index);
    if (menus.length !== 1) return [];
    const rows = [];
    for (const menu of menus) {
      for (const el of [...menu.querySelectorAll('[role]')]
        .filter((el) => isMenuRow(el) && el.closest('[role="menu"]') === menu)
        .filter(visible)) {
        const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || '')
          .replace(/\\s+/g, ' ')
          .trim();
        if (!text) continue;
        const lines = String(el.innerText || el.textContent || '')
          .split(/\\r?\\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        // Keep secondary native text in the public label. Codex can expose
        // two rows with the same title but a different usage qualifier; using
        // only lines[0] makes their current-value relationship ambiguous.
        const label = lines.join(' · ') || text;
        const accessibleName = String(el.getAttribute('aria-label') || text).replace(/\\s+/g, ' ').trim();
        rows.push({
          index: rows.length,
          optionId: 'codex.permission:' + fingerprint(accessibleName),
          label,
          // The closed trigger exposes the selected row's primary text while
          // the menu may add a secondary explanation. This is used only to
          // reconcile the native selected state within this one menu read.
          selectionKey: normalize(lines[0] || text),
          checked: isCurrent(el),
          disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
        });
      }
    }
    // Codex can render the selected permission with a presentational SVG only.
    // The trigger itself has a structural label/value pair, so derive the raw
    // current value from that value slot instead of matching the full trigger
    // text (which also contains the localized control label).
    if (rows.filter((row) => row.checked).length !== 1) {
      const root = trigger.querySelector(':scope > div') || trigger;
      const valueNodes = [...root.children]
        .filter((child) => child.tagName === 'SPAN')
        .map((child) => String(child.innerText || child.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const currentValue = normalize(valueNodes[valueNodes.length - 1] || '');
      const matches = currentValue ? rows.filter((row) => row.selectionKey === currentValue) : [];
      if (matches.length === 1) matches[0].checked = true;
    }
    rows.forEach((row) => { delete row.selectionKey; });
    return rows;
  })()`;
}

// The intelligence root has no stable business IDs for model/reasoning. Its
// ARIA ownership is stable within one rendered composer, so derive opaque IDs
// from the complete root row text and always re-check them before control.
function intelligenceRootControlsExpression() {
  return `(() => {
    const normalize = (value) => String(value || '').normalize('NFKC').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const fingerprint = (value) => {
      let hash = 0xcbf29ce484222325n;
      for (const char of normalize(value)) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
      }
      return hash.toString(16).padStart(16, '0');
    };
    const visible = (el) => {
      const rect = el && el.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
    if (!trigger) return [];
    const rootRows = (menu) => [...menu.querySelectorAll('[role]')]
      .filter((el) => el.closest('[role="menu"]') === menu)
      .filter((el) => ['menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(String(el.getAttribute('role') || '').toLowerCase()))
      .filter((el) => el.getAttribute('aria-haspopup') === 'menu' && el.hasAttribute('aria-controls'));
    const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) =>
      visible(menu) && rootRows(menu).length > 0
    );
    if (menus.length !== 1) return [];
    return rootRows(menus[0])
      .filter(visible)
      .map((el) => {
        const text = String(el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const submenuID = String(el.getAttribute('aria-controls') || '').trim();
        const triggerID = String(el.id || '').trim();
        return text && submenuID && triggerID ? {
          controlId: 'codex.intelligence:' + fingerprint(text),
          text,
          submenuId: submenuID,
          triggerId: triggerID,
        } : null;
      })
      .filter(Boolean);
  })()`;
}

function intelligenceSubmenuRowsExpression(controlID) {
  return `(() => {
    const controlID = ${JSON.stringify(String(controlID || ''))};
    const normalize = (value) => String(value || '').normalize('NFKC').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const fingerprint = (value) => {
      let hash = 0xcbf29ce484222325n;
      for (const char of normalize(value)) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
      }
      return hash.toString(16).padStart(16, '0');
    };
    const visible = (el) => {
      const rect = el && el.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const isMenuRow = (el) => ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option']
      .includes(String(el && el.getAttribute('role') || '').toLowerCase());
    const isCurrent = (el) => {
      const selected = (node) => node && (
        node.getAttribute('aria-checked') === 'true' ||
        node.getAttribute('aria-selected') === 'true' ||
        node.getAttribute('aria-current') === 'true' ||
        node.getAttribute('data-state') === 'checked' ||
        node.getAttribute('data-state') === 'selected' ||
        node.getAttribute('data-checked') === 'true' ||
        node.getAttribute('data-selected') === 'true'
      );
      return selected(el) || Boolean(el && el.querySelector(
        '[aria-checked="true"], [aria-selected="true"], [aria-current="true"], ' +
        '[data-state="checked"], [data-state="selected"], [data-checked="true"], [data-selected="true"]'
      ));
    };
    const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
    if (!trigger) return [];
    const rootRows = (menu) => [...menu.querySelectorAll('[role]')]
      .filter((el) => el.closest('[role="menu"]') === menu)
      .filter((el) => ['menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(String(el.getAttribute('role') || '').toLowerCase()))
      .filter((el) => el.getAttribute('aria-haspopup') === 'menu' && el.hasAttribute('aria-controls'));
    const roots = [...document.querySelectorAll('[role="menu"]')].filter((menu) =>
      visible(menu) && rootRows(menu).length > 0
    );
    if (roots.length !== 1) return [];
    const controls = rootRows(roots[0])
      .filter(visible)
      .map((el) => ({
        el,
        controlId: 'codex.intelligence:' + fingerprint(String(el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()),
      }))
      .filter((item) => item.controlId === controlID);
    if (controls.length !== 1) return [];
    const control = controls[0].el;
    // The advanced menu root has a structural label/value pair. The value is
    // raw Desktop text (not a localized Prism mapping) and identifies the
    // selected submenu row when Codex renders only a decorative SVG check.
    const rootContent = control.querySelector(':scope > div');
    const rootSpans = rootContent ? [...rootContent.children]
      .filter((child) => child.tagName === 'SPAN') : [];
    const currentValue = rootSpans.length >= 2
      ? String(rootSpans[rootSpans.length - 1].innerText || rootSpans[rootSpans.length - 1].textContent || '').replace(/\\s+/g, ' ').trim()
      : '';
    const submenuID = String(control.getAttribute('aria-controls') || '').trim();
    const menus = [
      submenuID ? document.getElementById(submenuID) : null,
      ...[...document.querySelectorAll('[role="menu"]')].filter((menu) =>
        String(menu.getAttribute('aria-labelledby') || '').trim() === String(control.id || '').trim()
      ),
    ].filter((menu, index, all) => menu && visible(menu) && all.indexOf(menu) === index);
    if (menus.length !== 1) return [];
    const rows = [...menus[0].querySelectorAll('[role]')]
      .filter((el) => isMenuRow(el) && el.closest('[role="menu"]') === menus[0])
      .filter(visible)
      .map((el, index) => {
        const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        if (!text) return null;
        const lines = String(el.innerText || el.textContent || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
        // Codex can render same-titled reasoning entries with a second-line
        // usage note. Keep the native full text so current selection remains
        // unambiguous without a locale-specific mapping.
        const label = lines.join(' · ') || text;
        const accessibleName = String(el.getAttribute('aria-label') || text).replace(/\\s+/g, ' ').trim();
        return {
          index,
          optionId: controlID + ':' + fingerprint(accessibleName),
          label,
          checked: isCurrent(el),
          disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
        };
      })
      .filter(Boolean);
    if (rows.filter((row) => row.checked).length !== 1) {
      const normalizedCurrent = normalize(currentValue);
      const matches = normalizedCurrent ? rows.filter((row) => normalize(row.label) === normalizedCurrent) : [];
      if (matches.length === 1) matches[0].checked = true;
    }
    return rows;
  })()`;
}

// The closed composer is the only surface a watcher may read. Codex renders a
// stable intelligence trigger with one combined value, but no independently
// addressable model/reasoning roots. Publish it as one control and require an
// explicit menu session to discover the real nested groups. Permission exposes
// its stable navigation target as the raw display label because Codex renders
// only the current value in the button.
function closedComposerControlsExpression() {
  return `(() => {
    const visible = (el) => {
      const rect = el && el.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const textOf = (el) => String(el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
    const valueOf = (el) => {
      if (!el) return '';
      const root = el.querySelector(':scope > div') || el;
      const values = [...root.children]
        .filter((child) => child.tagName === 'SPAN')
        .map((child) => textOf(child))
        .filter(Boolean);
      return values[values.length - 1] || textOf(el);
    };
    const permission = document.querySelector('[data-composer-navigation-target="permissions"]');
    const intelligence = document.querySelector('[data-codex-intelligence-trigger="true"]');
    return {
      permission: permission && visible(permission) ? {
        controlId: 'codex.permission', currentValue: valueOf(permission),
        displayLabel: String(permission.getAttribute('data-composer-navigation-target') || '').trim(),
      } : null,
      intelligence: intelligence && visible(intelligence) ? {
        controlId: 'codex.intelligence', currentValue: valueOf(intelligence),
      } : null,
    };
  })()`;
}

function sameComposerMenuRows(actual, expected) {
  if (!Array.isArray(expected) || expected.length === 0) return true;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((row, index) => {
    const saved = expected[index] || {};
    return String(row && row.optionId || '') === String(saved.optionId || saved.option_id || '') &&
      String(row && row.label || '') === String(saved.label || '') &&
      Boolean(row && row.disabled) === Boolean(saved.disabled);
  });
}

function sameConversationHeaderMenuRows(actual, expected) {
  if (!Array.isArray(expected) || expected.length === 0) return true;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((row, index) => {
    const saved = expected[index] || {};
    return String(row && row.optionId || '') === String(saved.optionId || saved.option_id || '') &&
      Boolean(row && row.disabled) === Boolean(saved.disabled);
  });
}

function sameQueueMenuRows(actual, expected) {
  if (!Array.isArray(expected) || expected.length === 0) return true;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((row, index) => {
    const saved = expected[index] || {};
    return String(row && (row.optionId || row.option_id) || '') === String(saved.optionId || saved.option_id || '') &&
      String(row && row.label || '') === String(saved.label || '') &&
      Boolean(row && row.disabled) === Boolean(saved.disabled);
  });
}

// Header menus have no product IDs. The watcher only proves that the current
// Header has candidate triggers; an explicit user describe opens candidates
// one at a time and retains the only one with remote-safe rows. This avoids a
// repeated background menu probe and never derives the owner from its text.
function conversationHeaderMenuHelpersSource() {
  return `
    const prismHeaderVisible = (el) => {
      const rect = el && el.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const prismHeaderText = (el) => String(el && (el.innerText || el.textContent || el.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim();
    const prismHeaderFiber = (el) => {
      const key = Object.keys(el || {}).find((name) => name.startsWith('__reactFiber$'));
      return key ? el[key] : null;
    };
    const prismHeaderHandlerSource = (el) => {
      const sources = [];
      for (let fiber = prismHeaderFiber(el), depth = 0; fiber && depth < 24; fiber = fiber.return, depth += 1) {
        const props = fiber.memoizedProps || {};
        for (const handler of [props.onSelect]) {
          if (typeof handler === 'function') sources.push(String(handler).replace(/\\s+/g, ' '));
        }
      }
      const unique = [...new Set(sources.filter(Boolean))];
      return unique.length === 1 ? unique[0] : '';
    };
    const prismHeaderFingerprint = (value) => {
      let hash = 0xcbf29ce484222325n;
      for (const char of String(value || '')) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
      return hash.toString(16).padStart(16, '0');
    };
    const prismHeaderDesktopOnly = (source) => /(?:openSideChat|open-in-new-window|thread-overflow|clipboard|open_in_browser_bridge|openExternal|window\\.open|location\\.(?:assign|replace|href)|showOpenDialog|showSaveDialog|dispatchHostMessage|startNewConversation|navigate|router\\.|history\\.(?:push|replace)|appPath|openMode:\\s*['\\x60]workspace)/i.test(source || '');
    const prismHeaderSurface = () => {
      const surfaces = [...document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')].filter(prismHeaderVisible);
      return surfaces.length === 1 ? surfaces[0] : null;
    };
    const prismHeaderTriggers = () => {
      const surface = prismHeaderSurface();
      if (!surface) return [];
      return [...surface.querySelectorAll('button[aria-haspopup="menu"]')]
        .filter(prismHeaderVisible)
        .filter((trigger) => Boolean(String(trigger.id || '').trim()))
        .filter((trigger) => !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true');
    };
    const prismHeaderTrigger = (triggerID) => {
      const targetID = String(triggerID || '').trim();
      const matches = prismHeaderTriggers().filter((trigger) => String(trigger.id || '') === targetID);
      return matches.length === 1 ? matches[0] : null;
    };
    const prismHeaderMenu = (triggerID) => {
      const trigger = prismHeaderTrigger(triggerID);
      if (!trigger || !trigger.id) return null;
      const menus = [...document.querySelectorAll('[role="menu"]')]
        .filter(prismHeaderVisible)
        .filter((menu) => String(menu.getAttribute('aria-labelledby') || '') === String(trigger.id));
      return menus.length === 1 ? menus[0] : null;
    };
    const prismHeaderRows = (triggerID) => {
      const menu = prismHeaderMenu(triggerID);
      if (!menu) return [];
      return [...menu.querySelectorAll('[role="menuitem"]')]
        .filter(prismHeaderVisible)
        .filter((el) => !el.hasAttribute('aria-haspopup'))
        .map((el, index) => {
          const source = prismHeaderHandlerSource(el);
          const label = prismHeaderText(el);
          if (!source || !label || prismHeaderDesktopOnly(source)) return null;
          return {
            index,
            optionId: 'conversation.header:' + prismHeaderFingerprint(source),
            label,
            disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
          };
        })
        .filter(Boolean);
    };
  `;
}

function conversationHeaderMenuRowsExpression(triggerID = '') {
  return `(() => {
    ${conversationHeaderMenuHelpersSource()}
    return prismHeaderRows(${JSON.stringify(String(triggerID || ''))});
  })()`;
}

function conversationHeaderMenuCandidateIDsExpression() {
  return `(() => {
    ${conversationHeaderMenuHelpersSource()}
    return prismHeaderTriggers().map((trigger) => String(trigger.id || '')).filter(Boolean);
  })()`;
}

function conversationHeaderMenuVisibleExpression(triggerID = '') {
  return `(() => {
    ${conversationHeaderMenuHelpersSource()}
    return Boolean(prismHeaderMenu(${JSON.stringify(String(triggerID || ''))}));
  })()`;
}

function conversationHeaderMenuAvailableExpression() {
  return `(() => {
    ${conversationHeaderMenuHelpersSource()}
    return prismHeaderTriggers().length > 0;
  })()`;
}

function macProfileDir() {
  return path.join(os.homedir(), "Library", "Application Support", "Codex");
}

function windowsProfileDir() {
  const appData = firstNonEmpty(process.env.APPDATA, process.env.LOCALAPPDATA);
  return appData ? path.join(appData, "Codex") : path.join(os.homedir(), "AppData", "Roaming", "Codex");
}

function linuxProfileDir() {
  const xdg = firstNonEmpty(process.env.XDG_CONFIG_HOME);
  return xdg ? path.join(xdg, "Codex") : path.join(os.homedir(), ".config", "Codex");
}

function defaultProfileDir() {
  if (process.platform === "darwin") return macProfileDir();
  if (process.platform === "win32") return windowsProfileDir();
  return linuxProfileDir();
}

function defaultAppPath() {
  if (process.platform === "darwin") {
    const standalone = "/Applications/Codex.app/Contents/MacOS/Codex";
    const chatgpt = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    return fs.existsSync(standalone) ? standalone : chatgpt;
  }
  if (process.platform === "win32") {
    return firstNonEmpty(
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "Codex.exe") : "",
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Codex", "Codex.exe") : "",
    );
  }
  return "codex";
}

function codexAppPath() {
  return firstNonEmpty(process.env.PRISM_CODEX_APP_PATH, defaultAppPath());
}

function macAppBundlePath(appPath = "") {
  const normalized = firstNonEmpty(appPath);
  if (!normalized) return "";
  if (normalized.endsWith(".app")) {
    return normalized;
  }
  const marker = ".app/";
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    return normalized.slice(0, index + marker.length - 1);
  }
  return "";
}

function defaultDevtoolsFile() {
  return path.join(defaultProfileDir(), "DevToolsActivePort");
}

function isCodexMainPageTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  // Codex exposes auxiliary pages such as avatar-overlay under index.html with
  // initialRoute query parameters. Only the exact workspace owns sidebar,
  // composer, and foreground-thread state.
  return String(target.url || "").trim() === "app://-/index.html";
}

function selectCodexMainPageTarget(targets) {
  return Array.isArray(targets) ? targets.find(isCodexMainPageTarget) || null : null;
}

// Capability probing must not launch Codex, wait for a composer, or contend
// with the long-lived watcher connection. It only proves the native CDP main
// page is reachable; foreground watcher reads prove workspace readiness.
// Electron can expose DevToolsActivePort before its workspace target is listed,
// so a single miss during Hub startup must not downgrade the registered remote
// capability for the entire Hub lifetime.
async function probeCodexMainPage(options = {}) {
  const overrideUrl = firstNonEmpty(process.env.PRISM_CODEX_CDP_URL, options.cdpUrl);
  const overridePort = firstNonEmpty(process.env.PRISM_CODEX_CDP_PORT, options.cdpPort ? String(options.cdpPort) : "");
  let listURL = "";
  if (overrideUrl) {
    listURL = overrideUrl.endsWith("/json/list") ? overrideUrl : `${overrideUrl.replace(/\/$/, "")}/json/list`;
  } else if (overridePort) {
    listURL = `http://127.0.0.1:${overridePort}/json/list`;
  } else {
    const userDataDir = firstNonEmpty(options.userDataDir, process.env.PRISM_CODEX_USER_DATA_DIR, defaultProfileDir());
    const devtoolsFile = firstNonEmpty(
      process.env.PRISM_CODEX_DEVTOOLS_FILE,
      options.devtoolsFile,
      userDataDir === defaultProfileDir() ? defaultDevtoolsFile() : path.join(userDataDir, "DevToolsActivePort"),
    );
    if (!devtoolsFile || !fs.existsSync(devtoolsFile)) return false;
    try {
      const lines = fs.readFileSync(devtoolsFile, "utf8").trim().split("\n");
      const port = firstNonEmpty(lines[0]);
      if (!port) return false;
      listURL = `http://127.0.0.1:${port}/json/list`;
    } catch {
      return false;
    }
  }
  const attempts = Math.max(1, Math.min(3, Number(options.attempts) || 3));
  const retryDelayMs = Math.max(0, Math.min(1_000, Number(options.retryDelayMs) || 300));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(listURL, {
        cache: "no-store",
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok && selectCodexMainPageTarget(await response.json())) return true;
    } catch {
      // The next bounded attempt handles the normal DevToolsActivePort → page
      // target publication race. A final failure remains fail-closed.
    }
    if (attempt + 1 < attempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}

function singletonArtifacts(userDataDir = "") {
  const root = firstNonEmpty(userDataDir);
  if (!root) return [];
  return [
    "DevToolsActivePort",
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "RunningChromeVersion",
  ].map((name) => path.join(root, name));
}

async function commandOutput(command, args = [], opts = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: opts.timeout || 4000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
      windowsHide: true,
    });
    return firstNonEmpty(result.stdout);
  } catch {
    return "";
  }
}

async function listCodexProcesses() {
  if (process.platform === "darwin" || process.platform === "linux") {
    const output = await commandOutput("/bin/sh", ["-lc", "ps ax -o pid=,command= | rg -i 'Codex(\\.app| )|ChatGPT\\.app|/Codex$|/Contents/MacOS/Codex|/Contents/MacOS/ChatGPT' || true"], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(output || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(Boolean);
  }
  if (process.platform === "win32") {
    const output = await commandOutput("cmd.exe", ["/c", "wmic process where \"name='Codex.exe'\" get ProcessId,CommandLine /format:list"], {
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const blocks = String(output || "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    return blocks.map((block) => {
      const command = firstNonEmpty((block.match(/^CommandLine=(.*)$/m) || [])[1]);
      const pid = Number(firstNonEmpty((block.match(/^ProcessId=(.*)$/m) || [])[1]));
      return pid ? { pid, command } : null;
    }).filter(Boolean);
  }
  return [];
}

function processMatchesUserDataDir(proc, userDataDir = "") {
  const normalized = firstNonEmpty(userDataDir);
  if (!normalized) {
    return true;
  }
  return String(proc && proc.command || "").includes(`--user-data-dir=${normalized}`);
}

async function isCodexRunning(userDataDir = "") {
  const processes = await listCodexProcesses();
  return processes.some((proc) => processMatchesUserDataDir(proc, userDataDir));
}

function cleanupStaleProfileArtifacts(userDataDir = "") {
  const root = firstNonEmpty(userDataDir);
  if (!root || !fs.existsSync(root)) return;
  for (const file of singletonArtifacts(root)) {
    try {
      fs.rmSync(file, { force: true, recursive: true });
    } catch {}
  }
}

async function stopExistingCodexProcess(userDataDir = "") {
  const targetDir = firstNonEmpty(userDataDir);
  if (process.platform === "darwin") {
    const defaultDir = defaultProfileDir();
    if (!targetDir || targetDir === defaultDir) {
      try {
        await execFileAsync("/usr/bin/osascript", ["-e", 'tell application "Codex" to quit'], {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });
      } catch {}
      try {
        await execFileAsync("/usr/bin/osascript", ["-e", 'tell application "ChatGPT" to quit'], {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });
      } catch {}
    }
    const gracefulDeadline = Date.now() + 12000;
    while (Date.now() < gracefulDeadline) {
      if (!(await isCodexRunning(targetDir))) {
        cleanupStaleProfileArtifacts(targetDir || defaultDir);
        return;
      }
      await sleep(300);
    }
    const processes = await listCodexProcesses();
    for (const proc of processes) {
      if (!processMatchesUserDataDir(proc, targetDir)) continue;
      await commandOutput("/bin/sh", ["-lc", `kill ${proc.pid} || true`], { timeout: 3000 });
    }
    const forceDeadline = Date.now() + 5000;
    while (Date.now() < forceDeadline) {
      if (!(await isCodexRunning(targetDir))) {
        cleanupStaleProfileArtifacts(targetDir || defaultDir);
        return;
      }
      await sleep(250);
    }
    const leftovers = await listCodexProcesses();
    for (const proc of leftovers) {
      if (!processMatchesUserDataDir(proc, targetDir)) continue;
      await commandOutput("/bin/sh", ["-lc", `kill -9 ${proc.pid} || true`], { timeout: 3000 });
    }
    cleanupStaleProfileArtifacts(targetDir || defaultDir);
    return;
  }
  if (process.platform === "win32") {
    if (targetDir) {
      const processes = await listCodexProcesses();
      for (const proc of processes) {
        if (!processMatchesUserDataDir(proc, targetDir)) continue;
        await commandOutput("cmd.exe", ["/c", `taskkill /PID ${proc.pid} /F`], { timeout: 8000, maxBuffer: 1024 * 1024 });
      }
    } else {
      await commandOutput("cmd.exe", ["/c", "taskkill /IM Codex.exe /F"], { timeout: 8000, maxBuffer: 1024 * 1024 });
    }
    return;
  }
  if (process.platform === "linux") {
    const processes = await listCodexProcesses();
    for (const proc of processes) {
      if (!processMatchesUserDataDir(proc, targetDir)) continue;
      await commandOutput("/bin/sh", ["-lc", `kill ${proc.pid} || true`], { timeout: 3000, maxBuffer: 1024 * 1024 });
    }
  }
}

async function waitForCodexStopped(timeoutMs = 15000, userDataDir = "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isCodexRunning(userDataDir))) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

function spawnManagedCodex(appPath, args, userDataDir = "") {
  const env = { ...process.env, HOME: os.homedir() };
  const cwd = path.parse(os.homedir()).root || "/";
  if (process.platform === "darwin") {
    const bundlePath = macAppBundlePath(appPath);
    if (bundlePath) {
      return {
        child: spawn("/usr/bin/open", ["-n", "-a", bundlePath, "--args", ...args], {
          detached: false,
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
          cwd,
          env,
        }),
        launcherExitsAfterStart: true,
      };
    }
  }
  return {
    child: spawn(appPath, args, {
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      cwd,
      env,
    }),
    launcherExitsAfterStart: false,
  };
}

class CodexDesktopController extends CdpPageClient {
  constructor(options = {}) {
    super(options);
    this.pageTarget = null;
    this.managedProcess = null;
    this.managedUserDataDir = "";
    this.managedDevtoolsFile = "";
    this.managedAppPath = "";
    this.managedLauncherExitsAfterStart = false;
  }

  async ensureReady() {
    // Check both the connected flag AND the actual ws readyState. The onclose handler
    // clears `connected`, but there is a window where the socket drops without onclose
    // firing yet, leaving connected=true while ws.readyState is CLOSING/CLOSED.
    const wsOpen = this.ws && this.ws.readyState === 1;
    if (!this.connected || !wsOpen) {
      this.connected = false;
      const target = await this.resolvePageTarget();
      this.pageTarget = target;
      await this.connectToPage(target.webSocketDebuggerUrl);
    }
    await this.waitForReady();
    await this.installInteractiveSurfaceCapabilityTracker();
    return this;
  }

  // Track the DOM relationship between the permission control and its menu.
  // This lets the watcher recognize the later confirmation dialog without
  // deriving any behavior from localized visible text.
  async installInteractiveSurfaceCapabilityTracker() {
    await this.evaluate(`(() => {
      const key = '__prismInteractiveSurfaceCapability';
      if (window[key] && window[key].installed === true) return true;
      const state = { installed: true, capability: '', expiresAt: 0 };
      const visible = (el) => {
        const rect = el && el.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const isPermissionMenuRow = (target) => {
        const row = target && target.closest && target.closest('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]');
        const trigger = document.querySelector('[data-composer-navigation-target="permissions"]');
        if (!row || !trigger || !visible(trigger)) return false;
        const menu = row.closest('[role="menu"], [role="listbox"]');
        if (!menu || !visible(menu)) return false;
        const triggerID = String(trigger.id || '').trim();
        const menuID = String(trigger.getAttribute('aria-controls') || '').trim();
        return (triggerID && String(menu.getAttribute('aria-labelledby') || '').trim() === triggerID) ||
          (menuID && String(menu.id || '').trim() === menuID);
      };
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest('[data-composer-navigation-target="permissions"]') || isPermissionMenuRow(target)) {
          state.capability = 'permission_confirmation';
          state.expiresAt = Date.now() + 5000;
        }
      }, true);
      window[key] = state;
      return true;
    })()`);
  }

  async resolvePageTarget() {
    const targetUserDataDir = firstNonEmpty(this.options.userDataDir, process.env.PRISM_CODEX_USER_DATA_DIR, defaultProfileDir());
    const overrideUrl = firstNonEmpty(process.env.PRISM_CODEX_CDP_URL, this.options.cdpUrl);
    if (overrideUrl) {
      const listUrl = overrideUrl.endsWith("/json/list") ? overrideUrl : overrideUrl.replace(/\/$/, "") + "/json/list";
      return this.fetchPageTarget(listUrl);
    }
    const overridePort = firstNonEmpty(process.env.PRISM_CODEX_CDP_PORT, this.options.cdpPort ? String(this.options.cdpPort) : "");
    if (overridePort) {
      return this.fetchPageTarget(`http://127.0.0.1:${overridePort}/json/list`);
    }
    const devtoolsFile = firstNonEmpty(process.env.PRISM_CODEX_DEVTOOLS_FILE, this.options.devtoolsFile);
    if (devtoolsFile && fs.existsSync(devtoolsFile)) {
      return this.fetchPageTarget(await this.devtoolsListUrlFromFile(devtoolsFile));
    }
    const defaultPortFile = targetUserDataDir === defaultProfileDir() ? defaultDevtoolsFile() : path.join(targetUserDataDir, "DevToolsActivePort");
    if (fs.existsSync(defaultPortFile)) {
      try {
        return await this.fetchPageTarget(await this.devtoolsListUrlFromFile(defaultPortFile));
      } catch {
        // Electron can leave DevToolsActivePort behind after ChatGPT/Codex exits.
        // Treat the default file as a cache, not as authoritative CDP state.
        try { fs.unlinkSync(defaultPortFile); } catch {}
      }
    }
    // A watcher is an observer. It must never turn an explicit user close into
    // a new Desktop process. Dashboard owns the only explicit managed launch
    // action and starts the app before the plugin reconnects over CDP.
    const allowManagedLaunch = this.options.allowManagedLaunch === true;
    const running = await isCodexRunning(targetUserDataDir);
    if (running) {
      const allowManagedRelaunch = allowManagedLaunch && this.options.allowManagedRelaunch === true;
      if (allowManagedRelaunch) {
        await stopExistingCodexProcess(targetUserDataDir);
        const stopped = await waitForCodexStopped(this.options.stopTimeoutMs || 15000, targetUserDataDir);
        if (!stopped) {
          throw new Error("Codex 已在运行，但 Prism 在受控重启模式下未能及时关闭旧进程。");
        }
        return this.launchManagedTarget();
      }
      throw new Error(
        "当前 Codex 已运行但没有暴露 CDP 端口，无法走 CDP-only 控制。请先关闭 Codex 后让 Prism 管理启动；普通用户优先在 Prism Dashboard 的插件页使用托管启动或手动指定应用路径 / 数据目录，只有开发者模式才建议配置 PRISM_CODEX_CDP_PORT / PRISM_CODEX_CDP_URL。",
      );
    }
    if (allowManagedLaunch) {
      return this.launchManagedTarget();
    }
    throw new Error("Codex Desktop 未运行。请在 Prism Dashboard 的插件页启动 Codex 后再连接。");
  }

  async devtoolsListUrlFromFile(file) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const port = firstNonEmpty(lines[0]);
    if (!port) {
      throw new Error(`invalid DevToolsActivePort file: ${file}`);
    }
    return `http://127.0.0.1:${port}/json/list`;
  }

  async fetchPageTarget(listUrl) {
    const deadline = Date.now() + (this.options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(listUrl, { cache: "no-store" });
        const targets = await response.json();
        const page = selectCodexMainPageTarget(targets);
        if (page) {
          return page;
        }
      } catch (err) {
        lastError = err;
      }
      await sleep(300);
    }
    throw lastError || new Error(`Codex CDP page target not found from ${listUrl}`);
  }

  async launchManagedTarget() {
    const userDataDir = firstNonEmpty(this.options.userDataDir, process.env.PRISM_CODEX_USER_DATA_DIR, defaultProfileDir());
    const appPath = codexAppPath();
    if (!appPath) {
      throw new Error("未找到 Codex 可执行路径，请设置 PRISM_CODEX_APP_PATH。");
    }
    cleanupStaleProfileArtifacts(userDataDir);
    const args = [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    const { child, launcherExitsAfterStart } = spawnManagedCodex(appPath, args, userDataDir);
    this.managedProcess = child;
    this.managedUserDataDir = userDataDir;
    this.managedDevtoolsFile = path.join(userDataDir, "DevToolsActivePort");
    this.managedAppPath = appPath;
    this.managedLauncherExitsAfterStart = launcherExitsAfterStart;
    const deadline = Date.now() + (this.options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (fs.existsSync(this.managedDevtoolsFile)) {
        return this.fetchPageTarget(await this.devtoolsListUrlFromFile(this.managedDevtoolsFile));
      }
      if (child.exitCode !== null) {
        if (launcherExitsAfterStart && child.exitCode === 0) {
          await sleep(250);
          continue;
        }
        throw new Error(`Codex 启动失败，exit=${child.exitCode}`);
      }
      await sleep(250);
    }
    throw new Error("等待 Codex CDP 端口超时。");
  }

  async relaunchManagedTarget() {
    const userDataDir = firstNonEmpty(this.managedUserDataDir, this.options.userDataDir, process.env.PRISM_CODEX_USER_DATA_DIR, defaultProfileDir());
    await this.close().catch(() => {});
    await stopExistingCodexProcess(userDataDir);
    const target = await this.launchManagedTarget();
    this.pageTarget = target;
    await this.connectToPage(target.webSocketDebuggerUrl);
    await this.waitForReady();
    return this;
  }

  async waitForReady() {
    await this.waitFor(
      // The sidebar is optional in current compact Desktop layouts. The
      // foreground thread carrier or a mounted Composer is the authoritative
      // readiness surface and remains available when the sidebar is hidden.
      "Boolean(document.querySelector('[data-above-composer-conversation-id]') || document.querySelector('[data-codex-composer-root], [data-codex-composer=\"true\"], [data-codex-composer]'))",
      this.options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS,
    );
  }

  async focusComposer() {
    const composer = composerEditableElementExpression();
    await this.clickElement(composer);
    await this.evaluate(`(() => { const el = (${composer}); if (!el) return false; el.focus(); return true; })()`);
  }

  // Electron may ignore CDP mouse coordinates while its native window is in
  // the background. This still targets the exact visible UI element via CDP.
  async clickDomElement(elementExpr) {
    const result = await this.evaluate(`(() => {
      const target = (${elementExpr});
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') return false;
      target.click();
      return true;
    })()`);
    if (!result) {
      throw new Error("CDP DOM target element not found or unavailable");
    }
  }

  async clearComposer() {
    await this.focusComposer();
    await this.keyPress("a", [process.platform === "darwin" ? "meta" : "control"]);
    await sleep(40);
    await this.keyPress("Backspace");
  }

  async setComposerText(text) {
    await this.clearComposer();
    if (text) {
      await this.insertText(text);
    }
  }

  async clearComposerAttachments() {
    await this.evaluate(`(() => {
      const visible = (element) => {
        const rect = element && element.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      // The primary card button opens the file. The final direct button is its
      // remove affordance across the current Codex attachment card variants.
      const buttons = [...document.querySelectorAll('.composer-attachment-surface')]
        .filter(visible)
        .map((card) => [...card.querySelectorAll(':scope > button')].at(-1))
        .filter(Boolean);
      for (const button of buttons) {
        button.click();
      }
      return buttons.length;
    })()`);
  }

  async resetComposer() {
    await this.clearComposerAttachments();
    await this.clearComposer();
  }

  async waitForComposerSendReady(timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastFacts = null;
    while (Date.now() < deadline) {
      const facts = await this.evaluate(composerPrimaryActionRuntimeExpression());
      lastFacts = facts && typeof facts === "object" ? facts : null;
      const standardSubmit = lastFacts
        && lastFacts.usable === true
        && lastFacts.enabled === true
        && lastFacts.submit_disabled !== true
        && lastFacts.interaction_blocked !== true
        && lastFacts.mode === "submit"
        && lastFacts.has_message_content === true;
      // A running Codex conversation whose Desktop preference is Queue keeps
      // its Fiber mode as `stop`, even after text is written. The single
      // primary DOM action nevertheless becomes the native queue submit. The
      // tuple below is the complete semantic guard; never infer it from the
      // localized aria-label or visible button text.
      const nativeQueueSubmit = lastFacts
        && lastFacts.usable === true
        && lastFacts.enabled === true
        && lastFacts.submit_disabled !== true
        && lastFacts.interaction_blocked !== true
        && lastFacts.mode === "stop"
        && lastFacts.response_in_progress === true
        && lastFacts.queueing_enabled === true
        && lastFacts.has_message_content === true;
      // In Guide mode Codex keeps the current turn's Fiber mode as Stop, but
      // the same primary node becomes the native guide submit once it holds
      // text. It is distinct from Queue only by the explicit Fiber flag.
      const nativeGuideSubmit = lastFacts
        && lastFacts.usable === true
        && lastFacts.enabled === true
        && lastFacts.submit_disabled !== true
        && lastFacts.interaction_blocked !== true
        && lastFacts.mode === "stop"
        && lastFacts.response_in_progress === true
        && lastFacts.queueing_enabled === false
        && lastFacts.has_message_content === true;
      if (standardSubmit || nativeQueueSubmit || nativeGuideSubmit) {
        return {
          ...lastFacts,
          submission_kind: nativeQueueSubmit ? "queue" : (nativeGuideSubmit ? "guide" : "send"),
        };
      }
      await sleep(100);
    }
    // Do not include composer content in the failure. These facts make a
    // timeout actionable while keeping user text out of Hub/API diagnostics.
    const diagnostic = lastFacts ? {
      usable: lastFacts.usable === true,
      enabled: lastFacts.enabled === true,
      mode: String(lastFacts.mode || ""),
      response_in_progress: lastFacts.response_in_progress === true,
      submit_disabled: lastFacts.submit_disabled === true,
      interaction_blocked: lastFacts.interaction_blocked === true,
      has_message_content: lastFacts.has_message_content === true,
    } : { unavailable: true };
    throw new Error(`queue_unavailable: native composer did not become submit-ready: ${JSON.stringify(diagnostic)}`);
  }

  async clickComposerPrimaryButton(expectedSubmissionKind = "") {
    const facts = await this.evaluate(composerPrimaryActionRuntimeExpression());
    if (!facts || facts.usable !== true || facts.enabled !== true || facts.submit_disabled === true) {
      throw new Error("control_target_stale");
    }
    const standardSubmit = facts.mode === "submit" && facts.has_message_content === true
      && facts.interaction_blocked !== true;
    const nativeQueueSubmit = facts.mode === "stop" && facts.response_in_progress === true
      && facts.queueing_enabled === true && facts.has_message_content === true
      && facts.interaction_blocked !== true;
    const nativeGuideSubmit = facts.mode === "stop" && facts.response_in_progress === true
      && facts.queueing_enabled === false && facts.has_message_content === true
      && facts.interaction_blocked !== true;
    if (!standardSubmit && !nativeQueueSubmit && !nativeGuideSubmit) {
      throw new Error("queue_unavailable");
    }
    const submissionKind = nativeQueueSubmit ? "queue" : (nativeGuideSubmit ? "guide" : "send");
    if (expectedSubmissionKind && expectedSubmissionKind !== submissionKind) {
      throw new Error("control_target_stale");
    }
    const action = composerPrimaryActionElementExpression();
    const available = await this.evaluate(`Boolean(${action})`);
    if (!available) {
      throw new Error("control_target_stale");
    }
    await this.clickElement(action);
    return { submission_kind: submissionKind };
  }

  async queuedMessageIDs() {
    const queue = await this.queuedMessageState().catch(() => null);
    return new Set((queue && Array.isArray(queue.items) ? queue.items : [])
      .map((item) => String(item && item.id || "").trim())
      .filter(Boolean));
  }

  async waitForQueuedMessageSubmission(previousQueueItemIDs, timeoutMs = 900) {
    const previous = previousQueueItemIDs instanceof Set ? previousQueueItemIDs : new Set();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const queue = await this.queuedMessageState().catch(() => null);
      const item = queue && Array.isArray(queue.items)
        ? queue.items.find((candidate) => {
          const id = String(candidate && candidate.id || "").trim();
          return id && !previous.has(id);
        })
        : null;
      if (item) {
        return { outcome: "queue_visible", queue_item_id: String(item.id) };
      }
      const surface = await this.readInteractiveSurface();
      if (surface) {
        return { outcome: "interactive_surface_opened", surface };
      }
      await sleep(150);
    }
    // Once the uniquely identified native primary action has been clicked, a
    // delayed queue row is not evidence that the send failed. Codex mounts the
    // row asynchronously; let the foreground watcher publish the authoritative
    // queue snapshot instead of turning a successful click into send_failed.
    return { outcome: "queue_pending" };
  }

  async waitForComposerSubmission(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    let sawEmptyComposer = false;
    while (Date.now() < deadline) {
      const state = await this.evaluate(`(() => {
        const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
        const composer = ${composerContainerElementExpression()};
        const composerText = textOf(composer);
        const attachmentRow = document.querySelector('[data-composer-attachments-row="true"]');
        const attachments = attachmentRow ? attachmentRow.querySelectorAll('[role="button"][aria-label]').length : 0;
        return {
          composerText,
          attachments,
        };
      })()`);
      // Some native actions keep the draft intact and open a confirmation
      // dialog. That is an accepted pending confirmation, not a timeout.
      const surface = await this.readInteractiveSurface();
      if (surface) {
        return { outcome: "interactive_surface_opened", surface };
      }
      if (state && !state.composerText && !state.attachments) {
        if (sawEmptyComposer) {
          return { outcome: "message_visible" };
        }
        sawEmptyComposer = true;
      }
      await sleep(150);
    }
    throw new Error("Codex message submission did not complete in time.");
  }

  async attachLocalFile(localPath, fileName = "", mimeType = "") {
    const resolvedPath = path.resolve(String(localPath || ""));
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error("Codex CDP 本地附件不存在。");
    }
    const attachment = {
      name: firstNonEmpty(fileName, path.basename(resolvedPath)),
      mimeType: firstNonEmpty(mimeType, "application/octet-stream"),
      base64: fs.readFileSync(resolvedPath).toString("base64"),
    };
    await this.focusComposer();
    const injection = await this.evaluate(`(async () => {
      const composer = ${composerContainerElementExpression()};
      if (!composer) return { ok: false, reason: 'composer_missing' };
      const fiberFor = (element) => {
        const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
        return key ? element[key] : null;
      };
      let composerController = null;
      for (let element = composer.parentElement; element && !composerController; element = element.parentElement) {
        for (let fiber = fiberFor(element), depth = 0; fiber && depth < 24; fiber = fiber.return, depth += 1) {
          const candidate = fiber.memoizedProps && fiber.memoizedProps.composerController;
          if (candidate && typeof candidate === 'object') {
            composerController = candidate;
            break;
          }
        }
      }
      if (!composerController) return { ok: false, reason: 'composer_controller_unavailable' };
      const bytes = Uint8Array.from(atob(${JSON.stringify(attachment.base64)}), c => c.charCodeAt(0));
      const file = new File([bytes], ${JSON.stringify(attachment.name)}, { type: ${JSON.stringify(attachment.mimeType)} });
      // The Desktop's native paste/file handlers receive Electron Files. A
      // browser-created File lacks its filesystem path and is silently
      // ignored by the generic-file handler, so retain the Hub materialized
      // path as a non-enumerable File property before dispatching it.
      Object.defineProperty(file, 'path', { value: ${JSON.stringify(resolvedPath)}, configurable: true });
      // Codex's image-paste handler serializes a browser-created File as a
      // data URI. That can exceed the agent's path handling limits. The native
      // generic file handler retains File.path for both images and documents,
      // while Codex still renders an image attachment card for image MIME types.
      const handlers = composerController.pastedFilesHandlers;
      if (!(handlers instanceof Map) || handlers.size === 0) {
        return { ok: false, reason: 'native_attachment_handler_unavailable' };
      }
      // Codex registers these handlers on ComposerController, rather than as
      // a DOM paste listener. Its native contract is a File[] payload.
      let invoked = 0;
      for (const handler of handlers.values()) {
        if (typeof handler !== 'function') continue;
        try {
          await Promise.resolve(handler([file]));
          invoked += 1;
        } catch (error) {
          return { ok: false, reason: 'native_attachment_handler_failed', handler_count: invoked, detail: String(error && error.message || error || '').slice(0, 240) };
        }
      }
      return invoked > 0 ? { ok: true, handler_count: invoked } : { ok: false, reason: 'native_attachment_handler_unavailable' };
    })()`);
    if (!injection || injection.ok !== true) {
      const reason = firstNonEmpty(injection && injection.reason, "native_attachment_injection_failed");
      throw new Error(`Codex CDP attachment injection unavailable: ${reason}`);
    }
    const attachmentStateExpression = `(() => {
      ${composerAttachmentStateSource()}
      return prismComposerAttachmentState(${JSON.stringify(attachment.name)});
    })()`;
    try {
      await this.waitFor(`(${attachmentStateExpression}).matched === true`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 100);
    } catch {
      const state = await this.evaluate(attachmentStateExpression).catch(() => null);
      const diagnostic = state && typeof state === 'object' ? JSON.stringify(state) : 'unavailable';
      throw new Error(`Codex CDP native Composer did not accept attachment name=${attachment.name} mime_type=${attachment.mimeType} state=${diagnostic}.`);
    }
  }

  async sendCurrentComposer(text) {
    await this.setComposerText(text);
    const ready = await this.waitForComposerSendReady();
    const previousQueueItemIDs = ready.submission_kind === "queue" ? await this.queuedMessageIDs() : null;
    await sleep(80);
    const submission = await this.clickComposerPrimaryButton(ready.submission_kind);
    if (submission.submission_kind === "queue") {
      return this.waitForQueuedMessageSubmission(previousQueueItemIDs);
    }
    return this.waitForComposerSubmission();
  }

  async sendMessage(payload = {}) {
    const text = firstNonEmpty(payload.text);
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    await this.resetComposer();
    for (const attachment of attachments) {
      const localPath = firstNonEmpty(attachment && attachment.localPath, attachment && attachment.local_path);
      const name = firstNonEmpty(attachment && attachment.name);
      const mimeType = firstNonEmpty(attachment && attachment.mimeType, attachment && attachment.mime_type);
      if (!localPath) {
        throw new Error("Codex CDP 缺少 Hub materialize 的本地附件路径。");
      }
      await this.attachLocalFile(localPath, name, mimeType);
      await sleep(80);
    }
    if (text) {
      await this.insertText(text);
    }
    const ready = await this.waitForComposerSendReady();
    const previousQueueItemIDs = ready.submission_kind === "queue" ? await this.queuedMessageIDs() : null;
    await sleep(80);
    const submission = await this.clickComposerPrimaryButton(ready.submission_kind);
    if (submission.submission_kind === "queue") {
      return this.waitForQueuedMessageSubmission(previousQueueItemIDs);
    }
    return this.waitForComposerSubmission();
  }

  async composerRuntimeState() {
    await this.ensureReady();
    return this.evaluate(`(() => {
      const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      ${approvalDOMHelpersSource()}
      const currentThreadId = ${foregroundThreadIdExpression()};
      const composer = ${composerContainerElementExpression()};
      const composerText = textOf(composer);
      ${composerPrimaryActionFactsSource()}
      const primary = prismComposerPrimaryActionFacts();
      const runtimeNotices = [...document.querySelectorAll('[role="status"], [aria-live], [data-testid*="toast"], [data-testid*="retry"], [data-testid*="connection"]')]
        .filter(visible)
        .map((el) => textOf(el))
        .filter((text, index, all) => text && all.indexOf(text) === index)
        .filter((text) => /(?:重新连接|重试|reconnect(?:ing)?|retry(?:ing)?)/i.test(text))
        .slice(-3)
        .map((text) => ({ title: text, detail: '', status: 'running', created_at: new Date().toISOString() }));
      const approval = collectApproval(currentThreadId);
      const waitingApproval = Boolean(approval);
      const running = primary && primary.usable === true && (
        primary.response_in_progress === true || primary.mode === 'stop'
      );
      // A running, empty Composer correctly exposes its primary button as
      // Stop.  The Fiber queueing flag is nevertheless the Desktop's authoritative
      // default for the next submitted message.  Do not require submit mode here:
      // Mobile needs this fact before it writes a message into the Composer.
      // The actual submission still waits for the real native submit button.
      const canQueue = Boolean(
        !waitingApproval && running && primary
        && primary.queueing_enabled === true && primary.enabled === true
        && primary.interaction_blocked !== true,
      );
      const queuePending = false;
      let primaryAction = 'send';
      if (waitingApproval) primaryAction = 'approval';
      else if (running) primaryAction = canQueue ? 'queue' : (primary && primary.mode === 'submit' ? 'guide' : 'interrupt');
      return {
        running,
        waiting_approval: waitingApproval,
        composer_text: composerText,
        composer_available: Boolean(composer && !composer.getAttribute('aria-disabled')),
        can_queue: canQueue,
        queue_pending: queuePending,
        primary_action: primaryAction,
        send_available: Boolean(primary && primary.usable === true && primary.enabled === true && !running && primary.submit_disabled !== true),
        interrupt_available: Boolean(primary && primary.usable === true && primary.enabled === true && running && primary.mode === 'stop'),
        approval,
        runtime_notices: runtimeNotices,
      };
    })()`);
  }

  async currentThreadRuntimeState() {
    await this.ensureReady();
    return this.evaluate(`(() => {
      const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      ${approvalDOMHelpersSource()}
      const currentThreadId = ${foregroundThreadIdExpression()};
      const composer = ${composerContainerElementExpression()};
      const anonymousDraftFingerprint = () => {
        if (currentThreadId || !composer) return '';
        let fiber = null;
        for (let node = composer; node && !fiber; node = node.parentElement) {
          const fiberKey = Object.keys(node).find((key) => key.startsWith('__reactFiber$'));
          fiber = fiberKey ? node[fiberKey] : null;
        }
        if (!fiber) return '';
        const visited = new Set();
        const findClientThreadID = (value, depth = 0) => {
          if (depth > 5 || value === null || value === undefined) return '';
          if (typeof value !== 'object' || visited.has(value)) return '';
          visited.add(value);
          if (typeof value.clientThreadId === 'string' && value.clientThreadId.trim()) {
            return value.clientThreadId.trim();
          }
          if (Array.isArray(value)) {
            for (const item of value.slice(0, 24)) {
              const found = findClientThreadID(item, depth + 1);
              if (found) return found;
            }
            return '';
          }
          for (const item of Object.values(value).slice(0, 80)) {
            const found = findClientThreadID(item, depth + 1);
            if (found) return found;
          }
          return '';
        };
        for (let index = 0; fiber && index < 24; index += 1, fiber = fiber.return) {
          const found = findClientThreadID(fiber.memoizedProps) || findClientThreadID(fiber.memoizedState);
          if (found) return found;
        }
        return '';
      };
      const clientThreadID = anonymousDraftFingerprint();
      const composerText = textOf(composer);
      ${composerPrimaryActionFactsSource()}
      const primary = prismComposerPrimaryActionFacts();
      ${goalPlanDOMHelpersSource()}
      const goalPlan = prismGoalPlanState();
      const approval = collectApproval(currentThreadId);
      const waitingApproval = Boolean(approval);
      const running = primary && primary.usable === true && (
        primary.response_in_progress === true || primary.mode === 'stop'
      );
      // See composerRuntimeState(): expose the Desktop queue preference even
      // while an empty Composer renders Stop for the current running turn.
      const canQueue = Boolean(
        !waitingApproval && running && primary
        && primary.queueing_enabled === true && primary.enabled === true
        && primary.interaction_blocked !== true,
      );
      const queuePending = false;
      let primaryAction = 'send';
      if (waitingApproval) primaryAction = 'approval';
      else if (running) primaryAction = canQueue ? 'queue' : (primary && primary.mode === 'submit' ? 'guide' : 'interrupt');
      return {
        current_thread_id: currentThreadId,
        client_thread_id: clientThreadID,
        running,
        waiting_approval: waitingApproval,
        composer_text: composerText,
        composer_available: Boolean(composer && !composer.getAttribute('aria-disabled')),
        can_queue: canQueue,
        queue_pending: queuePending,
        primary_action: primaryAction,
        send_available: Boolean(primary && primary.usable === true && primary.enabled === true && !running && primary.submit_disabled !== true),
        interrupt_available: Boolean(primary && primary.usable === true && primary.enabled === true && running && primary.mode === 'stop'),
        approval,
        plan_mode: goalPlan.plan_mode,
        goal: goalPlan.goal,
      };
    })()`);
  }

  async goalPlanState() {
    await this.ensureReady();
    return this.evaluate(`(() => {
      ${goalPlanDOMHelpersSource()}
      return prismGoalPlanState();
    })()`);
  }

  async openSlashCommand(iconPrefix) {
    const prefix = String(iconPrefix || "").trim();
    if (!prefix) throw new Error("control_target_stale: slash command icon is required");
    await this.setComposerText("/");
    const expression = `(() => {
      const visible = (element) => { const rect = element && element.getBoundingClientRect(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
      const rows = [...document.querySelectorAll('button[data-list-navigation-item=true]')]
        .filter(visible)
        .filter((button) => String(button.querySelector('svg path')?.getAttribute('d') || '').startsWith(${JSON.stringify(prefix)}));
      return rows.length === 1 ? rows[0] : null;
    })()`;
    await this.waitFor(`Boolean(${expression})`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 80);
    await this.dispatchDomPointerClick(expression);
  }

  async setPlanMode(enabled) {
    await this.ensureReady();
    const desired = enabled === true;
    const before = await this.goalPlanState();
    if (!before || !before.plan_mode || before.plan_mode.available !== true) {
      throw new Error("control_target_stale: plan mode is unavailable in the current desktop composer");
    }
    if (before.plan_mode.enabled === desired) return before.plan_mode;
    // Once Plan is active, Codex exposes its own persistent Composer toggle.
    // Going through the slash-command list a second time can target the
    // Composer's normal submit action after the menu has unmounted, which is
    // how a remote "close plan" was mistaken for a message send.
    if (!desired) {
      const indicator = `(() => { ${goalPlanDOMHelpersSource()} return prismPlanIndicator(); })()`;
      const available = await this.evaluate(`Boolean(${indicator})`);
      if (!available) {
        throw new Error("control_target_stale: active plan toggle is unavailable");
      }
      await this.dispatchDomPointerClick(indicator);
      await this.waitFor(`(() => { ${goalPlanDOMHelpersSource()} return prismGoalPlanState().plan_mode.enabled === false; })()`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 80);
      return (await this.goalPlanState()).plan_mode;
    }
    const draft = String(await this.evaluate(`(() => {
      const composer = ${composerContainerElementExpression()};
      return composer ? (composer.innerText || composer.textContent || '') : '';
    })()`) || "");
    try {
      await this.openSlashCommand(PLAN_ICON_PREFIX);
      await this.waitFor(`(() => { ${goalPlanDOMHelpersSource()} return prismGoalPlanState().plan_mode.enabled === ${JSON.stringify(desired)}; })()`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 80);
    } finally {
      await this.setComposerText(draft).catch(() => {});
    }
    const after = await this.goalPlanState();
    if (!after || !after.plan_mode || after.plan_mode.enabled !== desired) {
      throw new Error("control_target_stale: plan mode did not reach the requested state");
    }
    return after.plan_mode;
  }

  async setGoal(objective) {
    await this.ensureReady();
    const value = String(objective || "").trim();
    if (!value) throw new Error("control_target_stale: goal objective is required");
    const before = await this.goalPlanState();
    if (!before || !before.goal || before.goal.available !== true || before.goal.status !== "none") {
      throw new Error("control_target_stale: a current goal already exists or goal mode is unavailable");
    }
    const draft = String(await this.evaluate(`(() => {
      const composer = ${composerContainerElementExpression()};
      return composer ? (composer.innerText || composer.textContent || '') : '';
    })()`) || "");
    try {
      await this.openSlashCommand(GOAL_ICON_PREFIX);
      await this.setComposerText(value);
      const submit = goalComposerSubmitElementExpression();
      await this.waitFor(`Boolean(${submit})`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 80);
      await this.clickElement(submit);
      await this.waitFor(`(() => { ${goalPlanDOMHelpersSource()} const goal = prismGoalState(); return goal.status !== 'none' && goal.objective === ${JSON.stringify(value)}; })()`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 80);
    } finally {
      await this.setComposerText(draft).catch(() => {});
    }
    return (await this.goalPlanState()).goal;
  }

  async updateGoal(objective) {
    // Codex's native Edit Goal action opens a separate workspace page rather
    // than an in-place, conversation-scoped editor. Replacing a goal through
    // clear/set also leaves the native composer in an inconsistent lifecycle.
    // Do not mutate either the goal or the Desktop selection from a remote
    // edit request until Codex exposes a stable in-place edit contract.
    void objective;
    throw new Error("control_unsupported: Codex goal editing is not safely available remotely");
  }

  async controlGoal(action) {
    await this.ensureReady();
    const normalized = String(action || "").trim().toLowerCase();
    const kind = ({ "goal.pause": "pause", "goal.resume": "resume", "goal.clear": "clear" })[normalized];
    if (!kind) throw new Error("control_target_stale: unsupported goal action");
    const before = await this.goalPlanState();
    const expected = kind === "pause" ? "running" : kind === "resume" ? "paused" : "";
    if (!before || !before.goal || before.goal.status === "none" || (expected && before.goal.status !== expected)) {
      throw new Error("control_target_stale: goal action is no longer available");
    }
    await this.dispatchDomPointerClick(`(() => { ${goalPlanDOMHelpersSource()} return prismGoalControl(${JSON.stringify(kind)}); })()`);
    const desired = kind === "pause" ? "paused" : kind === "resume" ? "running" : "none";
    await this.waitFor(`(() => { ${goalPlanDOMHelpersSource()} return prismGoalState().status === ${JSON.stringify(desired)}; })()`, this.options.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT_MS, 80);
    return (await this.goalPlanState()).goal;
  }

  async queuedMessageState() {
    await this.ensureReady();
    return this.evaluate(`(() => {
      ${queueDOMHelpersSource()}
      const items = queueItemDescriptors();
      if (!items.length) return null;
      return { items, actions: queueLevelActions() };
    })()`);
  }

  async openQueuedMessageMenu(itemID) {
    const normalizedItemID = String(itemID || '').trim();
    if (!normalizedItemID) throw new Error('control_target_stale: queue_item_id is required');
    const triggerExpression = `(() => {
      ${queueDOMHelpersSource()}
      const trigger = queueMenuTrigger(${JSON.stringify(normalizedItemID)});
      return trigger && !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true' ? trigger : null;
    })()`;
    try {
      await this.dispatchDomPointerClick(triggerExpression);
    } catch {
      throw new Error('control_target_stale: queue item or its action menu is no longer present');
    }
    await this.waitFor(`(() => {
      ${queueDOMHelpersSource()}
      const trigger = queueMenuTrigger(${JSON.stringify(normalizedItemID)});
      return Boolean(trigger && trigger.getAttribute('aria-expanded') === 'true');
    })()`, DEFAULT_ACTION_TIMEOUT_MS, 50);
  }

  async describeQueuedMessageMenu(itemID) {
    const normalizedItemID = String(itemID || '').trim();
    if (!normalizedItemID) throw new Error('control_target_stale: queue_item_id is required');
    await this.openQueuedMessageMenu(normalizedItemID);
    try {
      const rows = await this.evaluate(`(() => {
        ${queueDOMHelpersSource()}
        return queueVisibleMenuRows(${JSON.stringify(normalizedItemID)});
      })()`);
      const diagnostics = await this.evaluate(`(() => {
        ${queueDOMHelpersSource()}
        return queueMenuDiagnostics(${JSON.stringify(normalizedItemID)});
      })()`).catch(() => null);
      if (diagnostics) {
        console.error(`[codex] queue menu diagnostics item_id=${normalizedItemID} ${JSON.stringify(diagnostics)}`);
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('control_target_stale: queue item menu has no readable entries');
      }
      const ids = rows.map((row) => String(row && row.optionId || '').trim());
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw new Error('control_target_stale: queue item menu entries are not uniquely identifiable');
      }
      return rows;
    } finally {
      await this.closeVisibleMenus();
    }
  }

  async applyQueuedMessageMenuSession(itemID, optionID, expectedRows = []) {
    const normalizedItemID = String(itemID || '').trim();
    const normalizedOptionID = String(optionID || '').trim();
    if (!normalizedItemID || !normalizedOptionID) {
      throw new Error('control_target_stale: queue menu item and option are required');
    }
    await this.openQueuedMessageMenu(normalizedItemID);
    try {
      const rows = await this.evaluate(`(() => {
        ${queueDOMHelpersSource()}
        return queueVisibleMenuRows(${JSON.stringify(normalizedItemID)});
      })()`);
      if (!sameQueueMenuRows(rows, expectedRows)) {
        throw new Error('control_target_stale: queue item menu structure changed');
      }
      const matches = (Array.isArray(rows) ? rows : []).filter((row) => row && row.optionId === normalizedOptionID && row.disabled !== true);
      if (matches.length !== 1) {
        throw new Error('control_target_stale: queue item menu entry is no longer uniquely available');
      }
      const target = `(() => {
        ${queueDOMHelpersSource()}
        const elements = queueMenuActionElements(${JSON.stringify(normalizedItemID)});
        const matches = elements.filter((el, index) => queueRemoteActionDescriptor(el, 'item.menu', index)?.id === ${JSON.stringify(normalizedOptionID)});
        const target = matches.length === 1 ? matches[0] : null;
        return target && !target.disabled && target.getAttribute('aria-disabled') !== 'true' ? target : null;
      })()`;
      try {
        // Queue overflow entries are Radix/Fiber-owned controls. Some entries
        // (notably edit) only consume the pointer sequence, whereas a bare
        // HTMLElement.click() reports success without invoking their handler.
        await this.dispatchDomPointerClick(target);
      } catch {
        throw new Error('control_target_stale: queue item menu entry disappeared before click');
      }
    } finally {
      await this.closeVisibleMenus();
    }
    await sleep(160);
  }

  async executeQueuedMessageAction(actionID, itemID = '') {
    const normalizedActionID = String(actionID || '').trim();
    const normalizedItemID = String(itemID || '').trim();
    if (!normalizedActionID) throw new Error('control_target_stale: queue action is required');
    const activateExpression = (scope) => `(() => {
      ${queueDOMHelpersSource()}
      const activate = (el) => {
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        el.focus && el.focus();
        const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
        const down = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
        const up = { bubbles: true, cancelable: true, button: 0, buttons: 0 };
        try { el.dispatchEvent(new PointerEvent('pointerdown', pointer)); } catch {}
        try { el.dispatchEvent(new MouseEvent('mousedown', down)); } catch {}
        try { el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 })); } catch {}
        try { el.dispatchEvent(new MouseEvent('mouseup', up)); } catch {}
        try { el.dispatchEvent(new MouseEvent('click', up)); } catch {}
        return true;
      };
      const actionID = ${JSON.stringify(normalizedActionID)};
      const itemID = ${JSON.stringify(normalizedItemID)};
      const candidates = ${scope === 'queue'
          ? 'queueLevelActions()'
          : `(() => { const item = queueItemDescriptors().find((entry) => entry.id === itemID); return item ? item.actions : []; })()`};
      const matched = candidates.find((action) => action && action.id === actionID && action.available !== false);
      if (!matched) return false;
      const elements = ${scope === 'queue'
          ? 'queueLevelActionElements()'
          : 'queueDirectActionElements(itemID)'};
      const element = elements.find((el, index) => {
        const descriptor = queueRemoteActionDescriptor(el, ${JSON.stringify(scope === 'queue' ? 'queue' : 'item.direct')}, index);
        return descriptor && descriptor.id === actionID;
      });
      return activate(element);
    })()`;
    let clicked = false;
    if (normalizedItemID) {
      clicked = await this.evaluate(activateExpression('direct'));
    } else {
      clicked = await this.evaluate(activateExpression('queue'));
    }
    if (!clicked) {
      throw new Error('control_target_stale: queue action is no longer present in the current desktop UI');
    }
    await sleep(160);
  }

  async currentThreadId() {
    await this.ensureReady();
    return this.evaluate(foregroundThreadIdExpression()).catch(() => "");
  }

  async isThreadSelected(threadId) {
    const normalized = String(threadId || "").trim();
    if (!normalized) return false;
    const current = String(await this.currentThreadId()).trim();
    return current === normalized || current.endsWith(`:${normalized}`);
  }

  async projectIdForCwd(cwd) {
    const normalizedCwd = String(cwd || "").trim();
    if (!normalizedCwd) {
      throw new Error("codex project cwd required");
    }
    const projectId = await this.evaluate(`(() => {
      const requestedCwd = ${JSON.stringify(normalizedCwd)};
      const findProject = (value, seen = new WeakSet(), depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return null;
        seen.add(value);
        if (value.path === requestedCwd && typeof value.projectId === 'string' && value.projectId.trim()) {
          return value.projectId.trim();
        }
        for (const child of Object.values(value)) {
          const found = findProject(child, seen, depth + 1);
          if (found) return found;
        }
        return null;
      };
      for (const row of document.querySelectorAll('[data-app-action-sidebar-project-row]')) {
        const propsKey = Object.keys(row).find((key) => key.startsWith('__reactProps$'));
        const projectId = propsKey ? findProject(row[propsKey]) : null;
        if (projectId) return projectId;
      }
      return '';
    })()`);
    const normalizedProjectId = String(projectId || "").trim();
    if (!normalizedProjectId) {
      throw new Error(`codex_project_not_visible_for_cwd: ${normalizedCwd}`);
    }
    return normalizedProjectId;
  }

  async ensureProjectExpanded(projectId) {
    const normalized = String(projectId || "").trim();
    if (!normalized) {
      return { expanded: false, reason: "project_id_missing" };
    }
    const rowScript = `(() => document.querySelector('[data-app-action-sidebar-project-id=${JSON.stringify(normalized)}]'))()`;
    let projectVisible = await this.evaluate(visibleElementScript(rowScript)).catch(() => false);
    // If the project row is in the DOM but not visible (scrolled out of the sidebar viewport),
    // scroll it into view before giving up. Previously this branch returned silently, which left
    // non-foreground sessions unselectable because the thread row stayed off-screen.
    if (!projectVisible) {
      const scrolled = await this.evaluate(`(() => {
        const row = ${rowScript};
        if (!row) return false;
        try {
          row.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        const rect = row.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      })()`).catch(() => false);
      if (!scrolled) {
        return { expanded: false, reason: "project_row_not_visible" };
      }
      await sleep(120);
      projectVisible = true;
    }
    const expandScript = `(() => {
      const row = document.querySelector('[data-app-action-sidebar-project-id=${JSON.stringify(normalized)}]');
      if (!row) return null;
      if (row.getAttribute('data-app-action-sidebar-project-collapsed') !== 'true') return null;
      return row.querySelector('button[aria-expanded]');
    })()`;
    const needsExpand = await this.evaluate(visibleElementScript(expandScript)).catch(() => false);
    if (needsExpand) {
      await this.clickElement(expandScript);
      await sleep(180);
    }
    return { expanded: true, alreadyExpanded: !needsExpand };
  }

  async selectThread(threadId) {
    const normalized = String(threadId || "").trim();
    if (!normalized) {
      throw new Error("Codex thread id required");
    }
    await this.ensureReady();
    if (await this.isThreadSelected(normalized)) {
      return { selected: true, alreadySelected: true };
    }
    const selectStartedAt = Date.now();
    try {
      await this.openThreadByDeepLink(normalized, THREAD_SELECTION_TIMEOUT_MS);
    } catch (error) {
      const message = String(error && error.message ? error.message : error || "");
      if (/deep link select timeout|CDP wait timed out/i.test(message)) {
        console.error(`[codex] selectThread incomplete thread_id=${normalized} reason=thread_row_not_visible`);
        return { selected: false, alreadySelected: false, reason: "thread_row_not_visible" };
      }
      throw error;
    }
    try {
      console.error(`[codex] selectThread costMs=${Date.now() - selectStartedAt} thread_id=${normalized}`);
    } catch {}
    await sleep(120);
    return { selected: true, alreadySelected: false };
  }

  async openThreadByDeepLink(threadId, timeoutMs = THREAD_SELECTION_TIMEOUT_MS) {
    const normalized = String(threadId || "").trim();
    if (!normalized) {
      throw new Error("Codex thread id required for deep link");
    }
    const url = `codex://threads/${normalized}`;
    await new Promise((resolve, reject) => {
      execFile("/usr/bin/open", [url], (err) => {
        if (err) reject(new Error(`deep link open failed: ${err.message}`));
        else resolve();
      });
    });
    const selectionTimeoutMs = Math.max(0, Number(timeoutMs) || THREAD_SELECTION_TIMEOUT_MS);
    const deadline = Date.now() + selectionTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.currentThreadId().catch(() => "");
      if (current === normalized || current.endsWith(`:${normalized}`)) {
        return;
      }
      await sleep(200);
    }
    throw new Error(`deep link select timeout after ${selectionTimeoutMs}ms: ${normalized}`);
  }

  async threadPinned(threadId) {
    const normalized = String(threadId || "").trim();
    if (!normalized) {
      return false;
    }
    return this.evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-row]')].find((el) => {
        const value = el.getAttribute('data-app-action-sidebar-thread-id') || '';
        return value === ${JSON.stringify(normalized)} || value.endsWith(':' + ${JSON.stringify(normalized)});
      });
      return row ? (row.getAttribute('data-app-action-sidebar-thread-pinned') === 'true') : false;
    })()`).catch(() => false);
  }

  async startNewProjectlessThread() {
    await this.ensureReady();
    const script = `(() => {
      const visible = (element) => {
        const rect = element && element.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const enabled = (element) => Boolean(
        element && !element.disabled && element.getAttribute('aria-disabled') !== 'true',
      );
      const fiberFor = (element) => {
        const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        return key ? element[key] : null;
      };
      const hooksHaveStartNewConversation = (fiber) => {
        const seen = new WeakSet();
        const contains = (value) => {
          if (value === null || value === undefined) return false;
          if (typeof value === 'function') return String(value).includes('startNewConversation');
          if (typeof value !== 'object' || seen.has(value)) return false;
          seen.add(value);
          return Object.values(value).some(contains);
        };
        for (let hook = fiber.memoizedState, depth = 0; hook && depth < 64; hook = hook.next, depth += 1) {
          if (contains(hook.memoizedState)) return true;
        }
        return false;
      };
      const isGlobalNewThreadButton = (element) => {
        for (let fiber = fiberFor(element), depth = 0; fiber && depth < 32; fiber = fiber.return, depth += 1) {
          const props = fiber.memoizedProps;
          if (props
            && Object.prototype.hasOwnProperty.call(props, 'homeComposerMode')
            && Object.prototype.hasOwnProperty.call(props, 'showQuickChatButton')
            && hooksHaveStartNewConversation(fiber)) return true;
        }
        return false;
      };
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(enabled)
        .filter(isGlobalNewThreadButton);
      return candidates.length === 1 ? candidates[0] : null;
    })()`;
    await this.waitFor(visibleElementScript(script), DEFAULT_ACTION_TIMEOUT_MS);
    await this.clickDomElement(script);
    await sleep(180);
    await sleep(260);
  }

  async startNewThreadInProject(cwd) {
    const normalized = String(cwd || "").trim();
    if (!normalized) {
      return this.startNewProjectlessThread();
    }
    await this.ensureReady();
    const projectId = await this.projectIdForCwd(normalized);
    const rowScript = `(() => document.querySelector('[data-app-action-sidebar-project-id=${JSON.stringify(projectId)}]'))()`;
    const expansion = await this.ensureProjectExpanded(projectId);
    if (!expansion || expansion.expanded !== true) {
      throw new Error(`codex_project_row_not_visible: ${projectId}`);
    }
    await this.waitFor(visibleElementScript(rowScript), DEFAULT_ACTION_TIMEOUT_MS);
    const newThreadScript = `(() => {
      const expectedProjectID = ${JSON.stringify(projectId)};
      const requestedCwd = ${JSON.stringify(normalized)};
      const visible = (element) => {
        const rect = element && element.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const enabled = (element) => Boolean(
        element && !element.disabled && element.getAttribute('aria-disabled') !== 'true',
      );
      const fiberFor = (element) => {
        const key = element && Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        return key ? element[key] : null;
      };
      const hasExactProject = (value, seen = new WeakSet(), depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return false;
        seen.add(value);
        if (value.projectId === expectedProjectID && value.path === requestedCwd) return true;
        return Object.values(value).some((child) => hasExactProject(child, seen, depth + 1));
      };
      const isProjectNewThreadButton = (element) => {
        let projectMatched = false;
        let startActionMatched = false;
        for (let fiber = fiberFor(element), depth = 0; fiber && depth < 18; fiber = fiber.return, depth += 1) {
          const props = fiber.memoizedProps;
          if (!props || typeof props !== 'object') continue;
          projectMatched ||= hasExactProject(props);
          startActionMatched ||= props.canStartNewThread === true && typeof props.onStartNewThread === 'function';
        }
        return projectMatched && startActionMatched;
      };
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(enabled)
        // The project action menu and the new-thread action share the same
        // project Fiber owner. The menu is the only candidate that declares
        // a popup, so exclude it without relying on a localized aria-label.
        .filter((element) => !element.hasAttribute('aria-haspopup'))
        .filter(isProjectNewThreadButton);
      return candidates.length === 1 ? candidates[0] : null;
    })()`;
    await this.waitFor(visibleElementScript(newThreadScript), DEFAULT_ACTION_TIMEOUT_MS);
    await this.clickDomElement(newThreadScript);
    await sleep(260);
  }

  async waitForFreshDraft(previousThreadId, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
    const previous = String(previousThreadId || "").trim();
    await this.waitFor(`(() => {
      const normalizeThreadId = (value) => {
        const text = String(value || '').trim();
        const match = text.match(/(^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        return match && match[2] ? match[2] : text;
      };
      const composer = ${composerContainerElementExpression()};
      if (!composer) return false;
      const rect = composer.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0 || composer.getAttribute('aria-disabled') === 'true') return false;
      const current = normalizeThreadId(document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id'));
      return current !== ${JSON.stringify(previous)};
    })()`, timeoutMs, 100);
  }

  async openPermissionMenu() {
    await this.ensureReady();
    await this.closeVisibleMenus();
    const script = `(() => document.querySelector('[data-composer-navigation-target="permissions"]'))()`;
    await this.clickElement(script);
    await this.waitFor(`(${visiblePermissionMenuRowsExpression()}).length > 0`, DEFAULT_ACTION_TIMEOUT_MS);
  }

  async openIntelligenceMenu() {
    await this.ensureReady();
    const script = `(() => document.querySelector('[data-codex-intelligence-trigger=\"true\"]'))()`;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.closeVisibleMenus();
      await this.clickElement(script);
      try {
        await this.waitFor(`(() => {
          const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
          if (!trigger || trigger.getAttribute('aria-expanded') !== 'true') return false;
          const visible = (el) => {
            const rect = el && el.getBoundingClientRect();
            return Boolean(rect && rect.width > 0 && rect.height > 0);
          };
          return [...document.querySelectorAll('[role="menu"]')].some((menu) =>
            visible(menu) && menu.getAttribute('aria-labelledby')
          );
        })()`, DEFAULT_ACTION_TIMEOUT_MS, 100);
        return;
      } catch (err) {
        lastError = err;
        await sleep(180);
      }
    }
    throw lastError || new Error("Codex intelligence menu did not open");
  }

  async intelligenceRootControls() {
    const controls = await this.evaluate(intelligenceRootControlsExpression());
    return Array.isArray(controls) ? controls : [];
  }

  async openIntelligenceControl(controlID) {
    const requestedControlID = String(controlID || "").trim();
    if (!requestedControlID) {
      throw new Error("control_target_stale: control_id is required");
    }
    await this.openIntelligenceMenu();
    const controls = await this.intelligenceRootControls();
    const matches = controls.filter((control) => control && control.controlId === requestedControlID);
    if (matches.length !== 1) {
      throw new Error("control_target_stale: intelligence control is not present in the current desktop menu");
    }
    const target = matches[0];
    const script = `(() => {
      const visible = (el) => {
        const rect = el && el.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const isRootRow = (el, menu) => el.closest('[role="menu"]') === menu &&
        ['menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(String(el.getAttribute('role') || '').toLowerCase()) &&
        el.getAttribute('aria-haspopup') === 'menu' && el.hasAttribute('aria-controls');
      const roots = [...document.querySelectorAll('[role="menu"]')].filter((menu) =>
        visible(menu) && [...menu.querySelectorAll('[role]')].some((el) => isRootRow(el, menu))
      );
      if (roots.length !== 1) return null;
      const root = roots[0];
      return [...root.querySelectorAll('[role]')]
        .filter((el) => isRootRow(el, root))
        .filter(visible)
        .find((el) => String(el.getAttribute('aria-controls') || '').trim() === ${JSON.stringify(target.submenuId)} && String(el.id || '').trim() === ${JSON.stringify(target.triggerId)}) || null;
    })()`;
    // The top-level intelligence trigger accepts a native CDP click, while
    // Radix opens its child menu only after the pointer sequence reaches this
    // exact ARIA-linked root element.
    await this.dispatchDomPointerClick(script);
    await this.waitFor(`(${intelligenceSubmenuRowsExpression(requestedControlID)}).length > 0`, DEFAULT_ACTION_TIMEOUT_MS, 100);
  }

  async listIntelligenceControlOptions(controlID, keepOpen = false) {
    await this.openIntelligenceControl(controlID);
    try {
      const rows = await this.evaluate(intelligenceSubmenuRowsExpression(controlID));
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error("control_target_stale: intelligence submenu is not readable");
      }
      return rows;
    } finally {
      if (!keepOpen) await this.closeVisibleMenus();
    }
  }

  // Codex renders model and reasoning as sibling roots below one combined
  // trigger. The closed trigger has no independently addressable roots, so a
  // user-initiated menu session discovers the roots and their native rows
  // together. Each child read deliberately reopens the root menu: this keeps
  // the result independent of Radix hover and focus behaviour.
  async listIntelligenceMenuGroups() {
    await this.openIntelligenceMenu();
    let controls;
    try {
      controls = await this.intelligenceRootControls();
    } finally {
      await this.closeVisibleMenus();
    }
    if (!Array.isArray(controls) || !controls.length) {
      throw new Error("control_target_stale: intelligence menu has no readable groups");
    }
    const groups = [];
    for (const control of controls) {
      const controlID = String(control && control.controlId || "").trim();
      const label = String(control && control.text || "").replace(/\s+/g, " ").trim();
      if (!controlID || !label) {
        throw new Error("control_target_stale: intelligence menu group is not uniquely identifiable");
      }
      const rows = await this.listIntelligenceControlOptions(controlID);
      groups.push({ control_id: controlID, label, rows });
    }
    return groups;
  }

  async conversationHeaderMenuAvailable() {
    await this.ensureReady();
    return this.evaluate(conversationHeaderMenuAvailableExpression()).catch(() => false);
  }

  async dispatchDomPointerClick(elementExpr) {
    const result = await this.evaluate(`(() => {
      const target = (${elementExpr});
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') return false;
      target.focus && target.focus();
      const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
      const down = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
      const up = { bubbles: true, cancelable: true, button: 0, buttons: 0 };
      try { target.dispatchEvent(new PointerEvent('pointerdown', pointer)); } catch {}
      try { target.dispatchEvent(new MouseEvent('mousedown', down)); } catch {}
      try { target.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 })); } catch {}
      try { target.dispatchEvent(new MouseEvent('mouseup', up)); } catch {}
      try { target.dispatchEvent(new MouseEvent('click', up)); } catch {}
      return true;
    })()`);
    if (!result) {
      throw new Error("CDP DOM target element not found or unavailable");
    }
  }

  async openConversationHeaderMenu() {
    await this.ensureReady();
    await this.closeVisibleMenus();
    const candidateIDs = await this.evaluate(conversationHeaderMenuCandidateIDsExpression());
    if (!Array.isArray(candidateIDs) || !candidateIDs.length) {
      throw new Error("control_target_stale: conversation menu trigger is unavailable");
    }
    const remoteSafeCandidateIDs = [];
    for (const candidateID of candidateIDs) {
      const triggerID = String(candidateID || '').trim();
      if (!triggerID) continue;
      await this.closeVisibleMenus();
      const target = `(() => {
        ${conversationHeaderMenuHelpersSource()}
        return prismHeaderTrigger(${JSON.stringify(triggerID)});
      })()`;
      try {
        await this.dispatchDomPointerClick(target);
        await this.waitFor(conversationHeaderMenuVisibleExpression(triggerID), DEFAULT_ACTION_TIMEOUT_MS, 100);
        const rows = await this.evaluate(conversationHeaderMenuRowsExpression(triggerID));
        if (Array.isArray(rows) && rows.length) remoteSafeCandidateIDs.push(triggerID);
      } catch {
        // A Header can also own run-location or other desktop-only menus.
        // They are not conversation actions unless this exact opening exposes
        // at least one row that passed the handler-side-effect filter.
      }
      await this.closeVisibleMenus();
    }
    if (remoteSafeCandidateIDs.length !== 1) {
      throw new Error("control_target_stale: conversation menu owner is not uniquely identifiable");
    }
    const triggerID = remoteSafeCandidateIDs[0];
    const target = `(() => {
      ${conversationHeaderMenuHelpersSource()}
      return prismHeaderTrigger(${JSON.stringify(triggerID)});
    })()`;
    await this.dispatchDomPointerClick(target);
    await this.waitFor(conversationHeaderMenuVisibleExpression(triggerID), DEFAULT_ACTION_TIMEOUT_MS, 100);
    const rows = await this.evaluate(conversationHeaderMenuRowsExpression(triggerID));
    if (!Array.isArray(rows) || !rows.length) {
      await this.closeVisibleMenus();
      throw new Error("control_target_stale: conversation menu changed before apply");
    }
    return triggerID;
  }

  async describeConversationHeaderMenu(keepOpen = false) {
    const triggerID = await this.openConversationHeaderMenu();
    try {
      const rows = await this.evaluate(conversationHeaderMenuRowsExpression(triggerID));
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error("control_target_stale: conversation menu has no remote-safe entries");
      }
      return rows;
    } finally {
      if (!keepOpen) await this.closeVisibleMenus();
    }
  }

  async applyConversationHeaderMenuSession(optionID, expectedRows = []) {
    const targetOptionID = String(optionID || "").trim();
    const expected = Array.isArray(expectedRows) ? expectedRows : [];
    const triggerID = await this.openConversationHeaderMenu();
    let surface = null;
    try {
      const rows = await this.evaluate(conversationHeaderMenuRowsExpression(triggerID));
      if (!sameConversationHeaderMenuRows(rows, expected)) {
        throw new Error("control_target_stale: conversation menu structure changed");
      }
      const matches = rows.filter((row) => row && row.optionId === targetOptionID && !row.disabled);
      if (matches.length !== 1) {
        throw new Error("control_target_stale: conversation menu entry is no longer uniquely available");
      }
      const target = `(() => {
        ${conversationHeaderMenuHelpersSource()}
        const menu = prismHeaderMenu(${JSON.stringify(triggerID)});
        if (!menu) return null;
        const matches = [...menu.querySelectorAll('[role="menuitem"]')]
          .filter(prismHeaderVisible)
          .filter((el) => !el.hasAttribute('aria-haspopup'))
          .filter((el) => {
            const source = prismHeaderHandlerSource(el);
            return source && !prismHeaderDesktopOnly(source) &&
              'conversation.header:' + prismHeaderFingerprint(source) === ${JSON.stringify(targetOptionID)};
          });
        return matches.length === 1 ? matches[0] : null;
      })()`;
      // Radix requires pointer events to open its Header trigger, but its
      // menu rows invoke the semantic onSelect callback from native click.
      await this.clickDomElement(target);
      await sleep(180);
      surface = await this.readInteractiveSurface();
    } finally {
      if (!surface) await this.closeVisibleMenus();
    }
    return { surface };
  }

  // Menu sessions are explicit user actions, but their temporary Desktop
  // popover is an implementation detail of the remote picker. Keep it
  // mounted and clickable for the DOM/ARIA operation while making it visually
  // transparent, then always remove the one-shot style before returning.
  async withTransparentNativeMenus(callback) {
    const styleID = `prism-menu-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await this.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = ${JSON.stringify(styleID)};
      style.textContent = '[role="menu"], [role="listbox"] { opacity: 0 !important; }';
      document.head.appendChild(style);
      return true;
    })()`);
    try {
      return await callback();
    } finally {
      await this.evaluate(`(() => document.getElementById(${JSON.stringify(styleID)})?.remove())()`).catch(() => null);
    }
  }

  async selectPermissionOption(optionID) {
    const targetOptionID = String(optionID || "").trim();
    const rows = await this.evaluate(visiblePermissionMenuRowsExpression());
    const matches = rows.filter((row) => row && row.optionId === targetOptionID && !row.disabled);
    if (matches.length !== 1) {
      throw new Error("control_target_stale: permission option is not uniquely present in the current desktop menu");
    }
    const targetIndex = matches[0].index;
    const script = `(() => {
      const visible = (el) => {
        const rect = el && el.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const isMenuRow = (el) => ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option']
        .includes(String(el && el.getAttribute('role') || '').toLowerCase());
      const trigger = document.querySelector('[data-composer-navigation-target="permissions"]');
      if (!trigger) return null;
      const menuID = String(trigger.getAttribute('aria-controls') || '').trim();
      const menus = [
        menuID ? document.getElementById(menuID) : null,
        ...[...document.querySelectorAll('[role="menu"]')].filter((menu) => String(menu.getAttribute('aria-labelledby') || '').trim() === String(trigger.id || '').trim()),
      ].filter((menu, index, all) => menu && visible(menu) && all.indexOf(menu) === index);
      if (menus.length !== 1) return null;
      return [...menus[0].querySelectorAll('[role]')]
        .filter((el) => isMenuRow(el) && el.closest('[role="menu"]') === menus[0])
        .filter(visible)[${Number(targetIndex)}] || null;
    })()`;
    await this.clickDomElement(script);
    await sleep(180);
  }

  async selectIntelligenceControlOption(controlID, optionID) {
    const targetControlID = String(controlID || "").trim();
    const targetOptionID = String(optionID || "").trim();
    const rows = await this.evaluate(intelligenceSubmenuRowsExpression(targetControlID));
    const matches = (Array.isArray(rows) ? rows : []).filter((row) => row && row.optionId === targetOptionID && !row.disabled);
    if (matches.length !== 1) {
      throw new Error("control_target_stale: intelligence option is not uniquely present in the current desktop menu");
    }
    const targetIndex = matches[0].index;
    const script = `(() => {
      const controlID = ${JSON.stringify(targetControlID)};
      const normalize = (value) => String(value || '').normalize('NFKC').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
      const fingerprint = (value) => {
        let hash = 0xcbf29ce484222325n;
        for (const char of normalize(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
        return hash.toString(16).padStart(16, '0');
      };
      const visible = (el) => {
        const rect = el && el.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const isRootRow = (el, menu) => el.closest('[role="menu"]') === menu &&
        ['menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(String(el.getAttribute('role') || '').toLowerCase()) &&
        el.getAttribute('aria-haspopup') === 'menu' && el.hasAttribute('aria-controls');
      const isMenuRow = (el) => ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option']
        .includes(String(el && el.getAttribute('role') || '').toLowerCase());
      const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
      if (!trigger) return null;
      const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) =>
        visible(menu) && [...menu.querySelectorAll('[role]')].some((el) => isRootRow(el, menu))
      );
      if (menus.length !== 1) return null;
      const root = menus[0];
      const roots = [...root.querySelectorAll('[role]')]
        .filter((el) => isRootRow(el, root))
        .filter(visible)
        .filter((el) => 'codex.intelligence:' + fingerprint(String(el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()) === controlID);
      if (roots.length !== 1) return null;
      const control = roots[0];
      const menuID = String(control.getAttribute('aria-controls') || '').trim();
      const submenuMenus = [
        menuID ? document.getElementById(menuID) : null,
        ...[...document.querySelectorAll('[role="menu"]')].filter((menu) => String(menu.getAttribute('aria-labelledby') || '').trim() === String(control.id || '').trim()),
      ].filter((menu, index, all) => menu && visible(menu) && all.indexOf(menu) === index);
      if (submenuMenus.length !== 1) return null;
      return [...submenuMenus[0].querySelectorAll('[role]')]
        .filter((el) => isMenuRow(el) && el.closest('[role="menu"]') === submenuMenus[0])
        .filter(visible)[${Number(targetIndex)}] || null;
    })()`;
    await this.clickDomElement(script);
    await sleep(180);
  }

  // Reopens exactly one native composer menu, verifies the complete session
  // fingerprint supplied by the Plugin, then clicks its opaque option. This
  // is the execution half of Prism's short-lived menu-session contract.
  async applyInteractiveComposerMenuSession(controlID, optionID, expectedRows = []) {
    const normalizedControlID = String(controlID || "").trim();
    const expected = Array.isArray(expectedRows) ? expectedRows : [];
    if (normalizedControlID === "codex.permission") {
      await this.openPermissionMenu();
      let surface = null;
      try {
		const rows = await this.evaluate(visiblePermissionMenuRowsExpression());
		if (!sameComposerMenuRows(rows, expected)) {
			throw new Error("control_target_stale: permission menu structure changed");
		}
        await this.selectPermissionOption(optionID);
        // Codex mounts the full-access confirmation asynchronously after the
        // menu item click. Do not close the menu before that real dialog has
        // had a short, bounded window to become readable.
        const deadline = Date.now() + 1200;
        do {
          surface = await this.readInteractiveSurface();
          if (surface) break;
          await sleep(80);
        } while (Date.now() < deadline);
      } finally {
        if (!surface) await this.closeVisibleMenus();
      }
      return { surface };
    }
    await this.openIntelligenceControl(normalizedControlID);
    let surface = null;
    try {
		const rows = await this.evaluate(intelligenceSubmenuRowsExpression(normalizedControlID));
		if (!sameComposerMenuRows(rows, expected)) {
			throw new Error("control_target_stale: intelligence menu structure changed");
		}
      await this.selectIntelligenceControlOption(normalizedControlID, optionID);
      surface = await this.readInteractiveSurface();
    } finally {
      if (!surface) await this.closeVisibleMenus();
    }
    return { surface };
  }

  async readInteractiveSurface() {
    const raw = await this.readInteractiveSurfaceRaw();
    return raw ? this.publicInteractiveSurface(raw) : null;
  }

  async applyInteractiveSurface(surfaceID, actionID, input = "") {
    const raw = await this.readInteractiveSurfaceRaw();
    const surface = raw ? this.publicInteractiveSurface(raw) : null;
    const targetSurfaceID = String(surfaceID || "").trim();
    const targetActionID = String(actionID || "").trim();
    if (!surface || surface.surface_id !== targetSurfaceID) {
      throw new Error("control_target_stale: desktop interaction surface is no longer present");
    }
    const actionIndex = surface.actions.findIndex((item) => item.action_id === targetActionID && item.available !== false);
    if (actionIndex < 0) {
      throw new Error("control_target_stale: desktop interaction action is no longer present");
    }
    const action = surface.actions[actionIndex];
    const rawAction = raw.actions
      .filter((item) => item && item.remoteAvailable !== false)
      .find((item) => this.interactiveSurfaceActionID(surface.surface_id, item) === targetActionID);
    if (!rawAction) {
      throw new Error("control_target_stale: desktop interaction action cannot be mapped to the current surface");
    }
    const suppliedInput = String(input || "");
    if (action.requires_input && !suppliedInput.trim()) {
      throw new Error("control_target_stale: desktop interaction action requires input");
    }
    if (!action.accepts_input && suppliedInput) {
      throw new Error("control_target_stale: desktop interaction action does not accept input");
    }
    if (suppliedInput) {
      if (surface.inputs.length !== 1) {
        throw new Error("control_target_stale: desktop interaction input is ambiguous");
      }
      await this.evaluate(`(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], form[aria-modal="true"]')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; });
        const dialog = dialogs[0];
        if (!dialog) return false;
        const inputs = [...dialog.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"]')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; });
        const input = inputs[0];
        if (!input) return false;
        if (input.isContentEditable) {
          input.textContent = ${JSON.stringify(suppliedInput)};
        } else {
          // React wraps the instance value setter to track controlled inputs.
          // Use the native setter so the following input event is observable.
          const prototype = input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(input, ${JSON.stringify(suppliedInput)});
          else input.value = ${JSON.stringify(suppliedInput)};
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(suppliedInput)} }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    }
    const clicked = await this.evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], form[aria-modal="true"]')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; });
      const dialog = dialogs[0];
      if (!dialog) return false;
      // Keep the index against every visible action: it is the same identity
      // captured by readInteractiveSurfaceRaw. Filtering disabled items here
      // would shift that index and can select a different confirmation button.
      const actions = [...dialog.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; });
      const action = actions[${Number(rawAction.index)}];
      if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
      // Codex's dialog actions are React/Radix controls. A bare .click() can
      // update no native state, even though it reports success to CDP.
      action.focus && action.focus();
      const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
      const down = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
      const up = { bubbles: true, cancelable: true, button: 0, buttons: 0 };
      try { action.dispatchEvent(new PointerEvent('pointerdown', pointer)); } catch {}
      try { action.dispatchEvent(new MouseEvent('mousedown', down)); } catch {}
      try { action.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 })); } catch {}
      try { action.dispatchEvent(new MouseEvent('mouseup', up)); } catch {}
      try { action.dispatchEvent(new MouseEvent('click', up)); } catch {}
      return true;
    })()`);
    if (!clicked) throw new Error("control_target_stale: desktop interaction action disappeared before click");
    // A native click only proves dispatch. Wait for Codex to consume it before
    // another remote control selects a different thread and tears down the form.
    const deadline = Date.now() + 1500;
    do {
      await sleep(80);
      const current = await this.readInteractiveSurface();
      if (!current || current.surface_id !== targetSurfaceID) return;
    } while (Date.now() < deadline);
    throw new Error("control_target_stale: desktop interaction did not complete");
  }

  async readInteractiveSurfaceRaw() {
    return this.evaluate(`(() => {
      const visible = (el) => { const rect = el && el.getBoundingClientRect(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
      const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const described = (dialog, attr) => String(dialog.getAttribute(attr) || '').split(/\\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(' ');
      const handlerSource = (element) => {
        const fiberKey = element && Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? element[fiberKey] : null;
        const sources = [];
        for (let depth = 0; fiber && depth < 4; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (!props || typeof props !== 'object') continue;
          for (const key of ['onClick', 'onSelect', 'onPress']) {
            if (typeof props[key] === 'function') sources.push(String(props[key]));
          }
        }
        return sources.join('\\n');
      };
      const desktopOnlyAction = (source) => /(?:open_in_browser_bridge|openExternal|window\\.open|location\\.(?:assign|replace|href)|clipboard|showOpenDialog|showSaveDialog|dispatchHostMessage)/i.test(source);
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], form[aria-modal="true"]')].filter(visible);
      if (dialogs.length !== 1) return null;
      const dialog = dialogs[0];
      const inputs = [...dialog.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"]')]
        .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
        .map((el, index) => ({ index, tag: el.tagName, type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', aria: el.getAttribute('aria-label') || '', label: text(el.labels?.[0]) || text(document.getElementById(el.getAttribute('aria-labelledby') || '')), placeholder: el.getAttribute('placeholder') || '', multiline: el.tagName === 'TEXTAREA' || el.getAttribute('aria-multiline') === 'true', required: el.required || el.getAttribute('aria-required') === 'true' }));
      const hasRequiredInput = inputs.some((item) => item.required);
      const allActions = [...dialog.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
        .filter((el) => visible(el))
        .map((el, index) => {
          const type = (el.getAttribute('type') || '').toLowerCase();
          const submits = type === 'submit' || (el.tagName === 'BUTTON' && !type && Boolean(el.closest('form')));
          const source = handlerSource(el);
          const label = text(el) || el.getAttribute('aria-label') || '';
          const directAction = submits || Boolean(source);
          return {
            index,
            tag: el.tagName,
            type,
            name: el.getAttribute('name') || '',
            id: el.id || '',
            dataAction: el.getAttribute('data-action') || el.getAttribute('data-value') || '',
            aria: el.getAttribute('aria-label') || '',
            label,
            available: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
            requiresInput: hasRequiredInput && submits,
            acceptsInput: inputs.length === 1 && submits,
            remoteAvailable: Boolean(label && directAction && !desktopOnlyAction(source)),
          };
        });
      const actions = allActions.filter((item) => item.remoteAvailable !== false);
      if (!actions.length) return null;
      const title = described(dialog, 'aria-labelledby') || text(dialog.querySelector('[data-radix-dialog-title], [role="heading"], h1, h2, h3'));
      const actionTail = allActions.map((item) => String(item.label || '').trim()).filter(Boolean).join(' ');
      const dialogText = text(dialog);
      const fallbackDescription = actionTail && dialogText.endsWith(actionTail)
        ? dialogText.slice(0, -actionTail.length).trim()
        : dialogText;
      const description = described(dialog, 'aria-describedby') || fallbackDescription;
      const capabilityState = window.__prismInteractiveSurfaceCapability;
      const capability = capabilityState && capabilityState.expiresAt > Date.now()
        ? String(capabilityState.capability || '')
        : '';
      return { role: dialog.getAttribute('role') || 'dialog', id: dialog.id || '', ariaLabel: dialog.getAttribute('aria-label') || '', title, description, inputs, actions, capability };
    })()`);
  }

  interactiveSurfaceActionID(surfaceID, item) {
    const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
    return `${surfaceID}:action:${digest(item)}`;
  }

  publicInteractiveSurface(raw) {
    if (!raw || typeof raw !== "object") return null;
    const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
    const actions = raw.actions.filter((item) => item && item.remoteAvailable !== false);
    const surfaceSeed = {
      role: raw.role,
      id: raw.id,
      ariaLabel: raw.ariaLabel,
      title: raw.title,
      description: raw.description,
      inputs: raw.inputs.map((item) => ({ tag: item.tag, type: item.type, name: item.name, aria: item.aria, label: item.label, placeholder: item.placeholder })),
      actions: actions.map((item) => ({ index: item.index, tag: item.tag, type: item.type, name: item.name, id: item.id, dataAction: item.dataAction, aria: item.aria, label: item.label, available: item.available, requiresInput: item.requiresInput, acceptsInput: item.acceptsInput })),
    };
    const surfaceID = `desktop-surface:${digest(surfaceSeed)}`;
    return {
      surface_id: surfaceID,
      capability: String(raw.capability || '').trim() || undefined,
      kind: "dialog",
      title: String(raw.title || "").trim(),
      description: String(raw.description || "").trim(),
      inputs: raw.inputs.map((item) => ({ input_id: `${surfaceID}:input:${digest(item)}`, label: String(item.label || "").trim(), placeholder: String(item.placeholder || "").trim(), multiline: item.multiline === true, required: item.required === true })),
      actions: actions.map((item) => ({ action_id: this.interactiveSurfaceActionID(surfaceID, item), label: String(item.label || item.aria || "").trim(), available: item.available !== false, requires_input: item.requiresInput === true, accepts_input: item.acceptsInput === true })),
    };
  }

  async closeVisibleMenus() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hasMenu = await this.evaluate(`(() => [...document.querySelectorAll('[role="menu"]')].some((menu) => {
        const rect = menu.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0;
      }))()`).catch(() => false);
      if (!hasMenu) return;
      await this.keyPress("Escape").catch(() => {});
      await sleep(120);
    }
  }

  async listPermissionOptions(keepOpen = false) {
    await this.openPermissionMenu();
    try {
      return await this.evaluate(visiblePermissionMenuRowsExpression());
    } finally {
      if (!keepOpen) {
        await this.closeVisibleMenus();
      }
    }
  }

  async composerControlState() {
    return this.evaluate(`(() => {
      const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
      const permission = document.querySelector('[data-composer-navigation-target="permissions"]');
      const intelligence = document.querySelector('[data-codex-intelligence-trigger="true"]');
      const effortAttr = intelligence ? (intelligence.getAttribute('data-selected-reasoning-effort') || '').trim() : '';
      return {
        permission: textOf(permission),
        intelligence: textOf(intelligence),
        model: '',
        reasoning: effortAttr,
        reasoningLabel: effortAttr,
        reasoningEffort: effortAttr,
      };
    })()`);
  }

  async closedComposerControls() {
    const controls = await this.evaluate(closedComposerControlsExpression());
    if (!controls || typeof controls !== "object") {
      return { permission: null, intelligence: null };
    }
    return {
      permission: controls.permission && typeof controls.permission === "object" ? controls.permission : null,
      intelligence: controls.intelligence && typeof controls.intelligence === "object" ? controls.intelligence : null,
    };
  }

  // This is deliberately read-only. Callers use it to avoid opening a menu
  // while Codex is still replacing the composer after a thread selection.
  async composerControlReadiness(threadId = "") {
    const expectedThreadId = String(threadId || "").trim();
    return this.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const normalizeThreadId = (value) => {
        const text = String(value || '').trim();
        const match = text.match(/(^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        return match && match[2] ? match[2] : text;
      };
      const selectedThreadId = normalizeThreadId(
        document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id')
      );
      const composer = ${composerContainerElementExpression()};
      const intelligence = document.querySelector('[data-codex-intelligence-trigger="true"]');
      const permission = document.querySelector('[data-composer-navigation-target="permissions"]');
      return {
        selected: ${JSON.stringify(expectedThreadId)} ? selectedThreadId === ${JSON.stringify(expectedThreadId)} : Boolean(selectedThreadId),
        composer: visible(composer),
        intelligence: visible(intelligence),
        permission: visible(permission),
      };
    })()`);
  }

  async interrupt() {
    await this.ensureReady();
    const clicked = await this.evaluate(composerStopClickExpression());
    if (!clicked || clicked.ok !== true) {
      throw new Error(clicked && clicked.reason ? clicked.reason : "interrupt_control_unavailable");
    }
    // The click above invokes Codex's live Composer handler. Its visual
    // progress state can remain `stop` while the desktop finishes cancelling
    // tools, so waiting for it to disappear turns a successfully dispatched
    // interruption into a false adapter failure. The plugin-wide watcher is
    // responsible for publishing the eventual terminal state.
  }

  async resolveApproval(actionId, inputValue = "") {
    const requestedActionId = String(actionId || "").trim();
    const requestedInput = String(inputValue || "").trim();
    if (!requestedActionId) {
      throw new Error("Codex approval action id required");
    }
    await this.ensureReady();
    const result = await this.evaluate(`(() => {
      const requestedActionId = ${JSON.stringify(requestedActionId)};
      const requestedInput = ${JSON.stringify(requestedInput)};
      const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      ${approvalDOMHelpersSource()}
      const dialog = findApprovalDialog();
      if (!dialog) return { ok: false, reason: 'Codex approval dialog is not visible' };
      const input = approvalInputElement(dialog);
      const actions = approvalActionElements(dialog);
      const matches = actions.filter((el) => approvalActionMatches(requestedActionId, el));
      if (matches.length !== 1) return { ok: false, reason: 'Codex approval action is no longer available: ' + requestedActionId };
      const action = matches[0];
      const requiresInput = approvalActionRequiresInput(action, input);
      if (requiresInput && !requestedInput) return { ok: false, reason: 'Codex approval action requires input' };
      if (!requiresInput && requestedInput) return { ok: false, reason: 'Codex approval action does not accept input' };
      if (requiresInput) {
        input.focus && input.focus();
        if (input.getAttribute('contenteditable') === 'true') {
          input.textContent = requestedInput;
        } else {
          const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(input, requestedInput);
          else input.value = requestedInput;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: requestedInput }));
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }
      action.focus && action.focus();
      const pointerInit = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
      const mouseDownInit = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
      const mouseUpInit = { bubbles: true, cancelable: true, button: 0, buttons: 0 };
      try { action.dispatchEvent(new PointerEvent('pointerdown', pointerInit)); } catch {}
      try { action.dispatchEvent(new MouseEvent('mousedown', mouseDownInit)); } catch {}
      try { action.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 })); } catch {}
      try { action.dispatchEvent(new MouseEvent('mouseup', mouseUpInit)); } catch {}
      try { action.dispatchEvent(new MouseEvent('click', mouseUpInit)); } catch {}
      return { ok: true };
    })()`);
    if (!result || result.ok !== true) {
      throw new Error(result && result.reason ? result.reason : "Codex approval action failed");
    }
    await sleep(220);
  }

}

function createCodexDesktopController(options = {}) {
  return new CodexDesktopController(options);
}

module.exports = {
  CodexDesktopController,
  createCodexDesktopController,
  defaultProfileDir,
  isCodexMainPageTarget,
  probeCodexMainPage,
  selectCodexMainPageTarget,
  __test: {
    goalPlanDOMHelpersSource,
    goalComposerSubmitElementExpression,
    composerEditableElementExpression,
  },
};
