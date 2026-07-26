const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = Object.freeze({
    home: Object.freeze(['M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.75v-6.25h-4.5V21H5a1 1 0 0 1-1-1z']),
    matches: Object.freeze(['M12 20.25S4 15.5 4 9.25A4.25 4.25 0 0 1 12 7.3a4.25 4.25 0 0 1 8 1.95c0 6.25-8 11-8 11Z']),
    messages: Object.freeze(['M4 5.75A1.75 1.75 0 0 1 5.75 4h12.5A1.75 1.75 0 0 1 20 5.75v8.5A1.75 1.75 0 0 1 18.25 16H9l-5 4v-4.8a1.7 1.7 0 0 1 0-.95z', 'M8 8.5h8M8 11.75h5.25']),
    groups: Object.freeze(['M8.25 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15.75 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 19.5v-1.25A4.25 4.25 0 0 1 7.75 14h1a4.25 4.25 0 0 1 4.25 4.25v1.25M14 14.35h2.25A4.25 4.25 0 0 1 20.5 18.6v.9']),
    profile: Object.freeze(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.75 21a7.25 7.25 0 0 1 14.5 0']),
    service_hub: Object.freeze(['M12 21s-7.5-4.45-7.5-10.5A4 4 0 0 1 12 8.55a4 4 0 0 1 7.5 1.95C19.5 16.55 12 21 12 21Z', 'M12 5.5v4M10 7.5h4']),
    phone: Object.freeze(['M8 2.75h8A1.75 1.75 0 0 1 17.75 4.5v15A1.75 1.75 0 0 1 16 21.25H8A1.75 1.75 0 0 1 6.25 19.5v-15A1.75 1.75 0 0 1 8 2.75ZM10.25 18.5h3.5']),
    desktop: Object.freeze(['M4 5.5h16v10H4zM2.5 19.5h19M9 19.5l.7-2h4.6l.7 2']),
    send: Object.freeze(['m21 3-7.25 18-3.75-7.25L3 10.5 21 3ZM10 13.75h4.1']),
    action_like: Object.freeze(['M12 20.25S4 15.5 4 9.25A4.25 4.25 0 0 1 12 7.3a4.25 4.25 0 0 1 8 1.95c0 6.25-8 11-8 11Z']),
    action_dislike: Object.freeze(['M7 7l10 10M17 7 7 17']),
    action_favorite: Object.freeze(['m12 3 2.78 5.64L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.9L12 3Z']),
    action_next: Object.freeze(['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4.7h-4.7']),
    action_chat: Object.freeze(['M4 5.75A1.75 1.75 0 0 1 5.75 4h12.5A1.75 1.75 0 0 1 20 5.75v8.5A1.75 1.75 0 0 1 18.25 16H9l-5 4v-4.8a1.7 1.7 0 0 1 0-.95z']),
    group_chat: Object.freeze(['M5.5 6.25h13A2.5 2.5 0 0 1 21 8.75v6.5a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3v-3H5.5A2.5 2.5 0 0 1 3 15.25v-6.5a2.5 2.5 0 0 1 2.5-2.5Z', 'M8 10h8M8 13.5h5']),
    forum: Object.freeze(['M5 4.5h14A2.5 2.5 0 0 1 21.5 7v9A2.5 2.5 0 0 1 19 18.5H9l-5.5 3v-3.75A2.5 2.5 0 0 1 2.5 16V7A2.5 2.5 0 0 1 5 4.5Z', 'M7 9h10M7 13h7']),
    edit_profile: Object.freeze(['M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3ZM13.75 8.25l3 3']),
    create_character: Object.freeze(['M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21a7 7 0 0 1 14 0', 'M19 5v4M17 7h4']),
    favorite: Object.freeze(['m12 3 2.78 5.64L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.9L12 3Z']),
    settings: Object.freeze(['M12 8.75A3.25 3.25 0 1 0 12 15.25 3.25 3.25 0 0 0 12 8.75Z', 'M19.1 13.5a7.7 7.7 0 0 0 .05-3l2-1.55-2-3.4-2.45 1a8 8 0 0 0-2.6-1.5L13.75 2.5h-4l-.35 2.55a8 8 0 0 0-2.6 1.5l-2.45-1-2 3.4 2 1.55a7.7 7.7 0 0 0 .05 3l-2.05 1.55 2 3.4 2.5-1a8 8 0 0 0 2.55 1.45l.35 2.6h4l.35-2.6a8 8 0 0 0 2.55-1.45l2.5 1 2-3.4-2.05-1.55Z']),
    connection: Object.freeze(['M8.5 15.5 5 19a2.12 2.12 0 0 1-3-3l4.5-4.5a2.12 2.12 0 0 1 3 0l1 1', 'M15.5 8.5 19 5a2.12 2.12 0 0 1 3 3l-4.5 4.5a2.12 2.12 0 0 1-3 0l-1-1', 'm8.5 15.5 7-7']),
    prompt: Object.freeze(['M5 3.5h11A2.5 2.5 0 0 1 18.5 6v15H7.5A2.5 2.5 0 0 1 5 18.5z', 'M8.5 8h6M8.5 12h6M8.5 16h3.5', 'M18.5 7.5H21v13H10']),
    privacy: Object.freeze(['M12 3 20 6.5v5.25c0 4.9-3.35 8.05-8 9.75-4.65-1.7-8-4.85-8-9.75V6.5z', 'm9 12 2 2 4-4']),
    image: Object.freeze(['M4 5h16v14H4z', 'm4 16 4.5-4.5 3.25 3.25L15 11.5l5 5', 'M15.5 8.5h.01']),
    sparkle: Object.freeze(['m12 3 1.25 4.25L17.5 8.5l-4.25 1.25L12 14l-1.25-4.25L6.5 8.5l4.25-1.25z', 'm18 15 .75 2.25L21 18l-2.25.75L18 21l-.75-2.25L15 18l2.25-.75z']),
    summary: Object.freeze(['M5 4h14v16H5z', 'M8 8h8M8 12h8M8 16h5']),
    console: Object.freeze(['M4 5h16v14H4z', 'm8 10 2 2-2 2M13 15h4']),
    info: Object.freeze(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 10.5V16M12 7.5h.01']),
    chevron_right: Object.freeze(['m9 5 7 7-7 7']),
    chevron_left: Object.freeze(['m15 5-7 7 7 7']),
    close: Object.freeze(['M6.5 6.5l11 11M17.5 6.5l-11 11']),
    more_vertical: Object.freeze(['M12 5.75h.01M12 12h.01M12 18.25h.01']),
    refresh: Object.freeze(['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4.7h-4.7']),
    clock: Object.freeze(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.5V12l3 2']),
    channel_mood: Object.freeze(['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 2.75v2.5M12 18.75v2.5M2.75 12h2.5M18.75 12h2.5M5.4 5.4l1.75 1.75M16.85 16.85l1.75 1.75M18.6 5.4l-1.75 1.75M7.15 16.85 5.4 18.6']),
    channel_nearby: Object.freeze(['M12 21s-6.5-5.3-6.5-10.25a6.5 6.5 0 1 1 13 0C18.5 15.7 12 21 12 21Z', 'M12 12.75a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z']),
    channel_moments: Object.freeze(['M4 8.5a1.75 1.75 0 0 1 1.75-1.75H8l1.25-2h5.5l1.25 2h2.25A1.75 1.75 0 0 1 20 8.5v9a1.75 1.75 0 0 1-1.75 1.75H5.75A1.75 1.75 0 0 1 4 17.5z', 'M12 15.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z']),
    channel_interests: Object.freeze(['m12 3 2.78 5.64L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.9L12 3Z']),
    channel_topics: Object.freeze(['M9.5 4.5 8 19.5M16 4.5l-1.5 15M5 9.25h15M4 14.75h15']),
    channel_night: Object.freeze(['M20.5 13.25A8.75 8.75 0 1 1 10.75 3.5a7 7 0 0 0 9.75 9.75Z']),
    channel_banter: Object.freeze(['M4 5.75A1.75 1.75 0 0 1 5.75 4h12.5A1.75 1.75 0 0 1 20 5.75v8.5A1.75 1.75 0 0 1 18.25 16H9l-5 4v-4.8a1.7 1.7 0 0 1 0-.95z', 'M12 12.6S9.4 11 9.4 9.15a1.45 1.45 0 0 1 2.6-.85 1.45 1.45 0 0 1 2.6.85c0 1.85-2.6 3.45-2.6 3.45Z']),
    channel_dates: Object.freeze(['M7 4.5h10A1.5 1.5 0 0 1 18.5 6v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V6A1.5 1.5 0 0 1 7 4.5Z', 'M9 3v3M15 3v3M9 11.5h6M9 15h4']),
    // —— 设计系统 2.0 追加（策划书 §3.4）：仅新增，不改动已有条目 ——
    logo: Object.freeze([
        'M4 5.75A1.75 1.75 0 0 1 5.75 4h12.5A1.75 1.75 0 0 1 20 5.75v8.5A1.75 1.75 0 0 1 18.25 16H9l-5 4v-4.8a1.7 1.7 0 0 1 0-.95z',
        'M12 13.1S8.9 11.2 8.9 8.9a1.7 1.7 0 0 1 3.1-.95 1.7 1.7 0 0 1 3.1.95c0 2.3-3.1 4.2-3.1 4.2Z'
    ]),
    grip: Object.freeze(['M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01']),
    pin: Object.freeze(['M9 3.75h6', 'M10 3.75v4.6L7.75 10.9v2.85h8.5V10.9L14 8.35v-4.6', 'M12 13.75v6.5']),
    search: Object.freeze(['M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5Z', 'm15.6 15.6 4.65 4.65']),
    plus: Object.freeze(['M12 5.25v13.5M5.25 12h13.5']),
    hearts: Object.freeze([
        'M9.5 17.5S3.25 13.7 3.25 8.9a3.4 3.4 0 0 1 6.25-1.55A3.4 3.4 0 0 1 15.75 8.9c0 1.1-.33 2.15-.85 3.1',
        'M16.5 20.75s-4.25-2.6-4.25-5.85a2.35 2.35 0 0 1 4.25-1.05 2.35 2.35 0 0 1 4.25 1.05c0 3.25-4.25 5.85-4.25 5.85Z'
    ])
});

function svgElement(documentRef, tag) {
    return documentRef.createElementNS?.(SVG_NS, tag) ?? documentRef.createElement(tag);
}

export function createUiIcon(documentRef, name, { className = 'yl-ui-icon', size = 20, strokeWidth = 1.8 } = {}) {
    const key = Object.hasOwn(ICON_PATHS, name) ? name : 'profile';
    const svg = svgElement(documentRef, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(strokeWidth));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.dataset.icon = key;
    for (const d of ICON_PATHS[key]) {
        const path = svgElement(documentRef, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

export const UI_ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS));

