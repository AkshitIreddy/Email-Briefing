import React, { useEffect, useMemo, useState } from 'react';
import { TopicDashboard, DashboardKeyPoint, SearchSource, DashboardImage } from './types';

// ============================================
// TWEMOJI — crisp, beautiful emoji rendered from the Twemoji CDN,
// falling back to the native glyph if the image can't load
// ============================================

export const Emoji = ({ char, size = 20 }: { char: string; size?: number }) => {
    const [failed, setFailed] = useState(false);
    const code = useMemo(() => {
        try {
            const points = [...char].map(c => c.codePointAt(0)!.toString(16));
            const filtered = points.length > 1 ? points.filter(p => p !== 'fe0f') : points;
            return filtered.join('-');
        } catch {
            return null;
        }
    }, [char]);
    if (!code || failed) return <span className="emoji-native" style={{ fontSize: size * 0.9 }}>{char}</span>;
    return (
        <img
            className="emoji-img"
            width={size}
            height={size}
            alt={char}
            draggable={false}
            src={`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${code}.svg`}
            onError={() => setFailed(true)}
        />
    );
};

// ============================================
// RICH TEXT — renders ==highlight== and **bold**
// ============================================

export function richText(text: string, highlightsEnabled: boolean): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const pattern = /(==[^=]+==|\*\*[^*]+\*\*)/g;
    const parts = text.split(pattern);
    parts.forEach((part, i) => {
        if (part.startsWith('==') && part.endsWith('==')) {
            const inner = part.slice(2, -2);
            nodes.push(highlightsEnabled
                ? <mark key={i} className="hl">{inner}</mark>
                : <strong key={i}>{inner}</strong>);
        } else if (part.startsWith('**') && part.endsWith('**')) {
            nodes.push(<strong key={i}>{part.slice(2, -2)}</strong>);
        } else if (part) {
            nodes.push(<React.Fragment key={i}>{part}</React.Fragment>);
        }
    });
    return nodes;
}

function hostnameOf(url: string, fallback: string): string {
    try { return new URL(url).hostname.replace('www.', ''); } catch { return fallback; }
}

// ============================================
// SHARED SECTIONS
// ============================================

interface SectionProps {
    dash: TopicDashboard;
    hl: boolean;
    openExternal: (url: string) => void;
    onOpenEmail?: (emailId: string) => void;
}

const SentimentPill = ({ sentiment }: { sentiment: string }) => (
    <span className={`sentiment-pill ${sentiment.toLowerCase()}`}>
        {sentiment === 'Positive' ? '▲' : sentiment === 'Negative' ? '▼' : '●'} {sentiment}
    </span>
);

const TemplateBadge = ({ template }: { template: string }) => {
    const names: Record<string, string> = {
        pulse: 'Pulse Board', editorial: 'Editorial', timeline: 'Chronicle',
        spotlight: 'Spotlight', matrix: 'Matrix',
    };
    return <span className={`template-badge tb-${template}`}>{names[template] || template}</span>;
};

const StatTiles = ({ dash }: { dash: TopicDashboard }) => {
    if (!dash.content.stats?.length) return null;
    return (
        <div className="stat-tiles">
            {dash.content.stats.map((s, i) => (
                <div className="stat-tile" key={i} style={{ animationDelay: `${i * 0.06}s` }}>
                    <div className="stat-value">{s.value}</div>
                    <div className="stat-label">{s.label}</div>
                    {s.context && <div className="stat-context">{s.context}</div>}
                </div>
            ))}
        </div>
    );
};

const KeyPointItem = ({ point, hl }: { point: DashboardKeyPoint; hl: boolean }) => (
    <li className={`key-point ${point.is_sponsored ? 'sponsored' : ''}`}>
        {point.tag && <span className="point-tag">{point.tag}</span>}
        {point.is_sponsored && <span className="point-tag ad-tag">Ad</span>}
        <span>{richText(point.text, hl)}</span>
    </li>
);

const KeyPoints = ({ dash, hl, title = 'The Story' }: { dash: TopicDashboard; hl: boolean; title?: string }) => {
    if (!dash.content.key_points?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">{title}</h3>
            <ul className="key-points">
                {dash.content.key_points.map((p, i) => <KeyPointItem key={i} point={p} hl={hl} />)}
            </ul>
        </section>
    );
};

const TimelineSection = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.timeline?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">Timeline</h3>
            <div className="timeline-track">
                {dash.content.timeline.map((t, i) => (
                    <div className="timeline-item" key={i} style={{ animationDelay: `${i * 0.08}s` }}>
                        <div className="timeline-marker" />
                        <div className="timeline-body">
                            <div className="timeline-label">{t.label}</div>
                            <div className="timeline-text">{richText(t.text, hl)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
};

const Quotes = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.quotes?.length) return null;
    return (
        <section className="dash-section">
            {dash.content.quotes.map((q, i) => (
                <blockquote className="pull-quote" key={i}>
                    <p>“{richText(q.text, hl)}”</p>
                    {q.attribution && <cite>— {q.attribution}</cite>}
                </blockquote>
            ))}
        </section>
    );
};

const WebContext = ({ dash, hl, openExternal }: SectionProps) => {
    if (!dash.content.web_context?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">From Around the Web</h3>
            <div className="web-context-grid">
                {dash.content.web_context.map((w, i) => {
                    const src = w.source_index != null ? dash.sources[w.source_index - 1] : undefined;
                    return (
                        <div className="web-context-card" key={i}>
                            <h4>{w.title}</h4>
                            <p>{richText(w.text, hl)}</p>
                            {src && (
                                <button className="source-link" onClick={() => openExternal(src.url)}>
                                    ↗ {hostnameOf(src.url, 'source')}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
};

const FunFact = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.fun_fact) return null;
    return (
        <div className="fun-fact">
            <span className="fun-fact-icon"><Emoji char="💡" size={22} /></span>
            <span>{richText(dash.content.fun_fact, hl)}</span>
        </div>
    );
};

// A full-width image that visually separates blocks of text
const Breather = ({ img, openExternal }: { img?: DashboardImage; openExternal: (url: string) => void }) => {
    if (!img) return null;
    return (
        <figure className="breather" onClick={() => img.sourceUrl && openExternal(img.sourceUrl)}>
            <img src={img.url} alt={img.title || ''} loading="lazy"
                onError={(e) => { (e.currentTarget.closest('figure') as HTMLElement).style.display = 'none'; }} />
            {img.title && <figcaption>{img.title}</figcaption>}
        </figure>
    );
};

const ImageStrip = ({ images, openExternal, skip = 0 }: { images: DashboardImage[]; openExternal: (url: string) => void; skip?: number }) => {
    const list = (images || []).slice(skip);
    if (!list.length) return null;
    return (
        <div className="image-strip">
            {list.map((img, i) => (
                <figure className="dash-image" key={i} onClick={() => img.sourceUrl && openExternal(img.sourceUrl)}>
                    <img src={img.url} alt={img.title || 'related'} loading="lazy"
                        onError={(e) => { (e.currentTarget.closest('figure') as HTMLElement).style.display = 'none'; }} />
                    {img.title && <figcaption>{img.title}</figcaption>}
                </figure>
            ))}
        </div>
    );
};

const SourcesFooter = ({ dash, openExternal, onOpenEmail }: { dash: TopicDashboard; openExternal: (url: string) => void; onOpenEmail?: (emailId: string) => void }) => (
    <footer className="dash-footer">
        {dash.sources.length > 0 && (
            <div className="sources-block">
                <h4>Sources</h4>
                <div className="source-chips">
                    {dash.sources.map((s: SearchSource, i) => (
                        <button className="source-chip" key={i} title={s.title} onClick={() => openExternal(s.url)}>
                            <span className="source-num">{i + 1}</span>
                            {hostnameOf(s.url, s.title)}
                        </button>
                    ))}
                </div>
            </div>
        )}
        <div className="sources-block">
            <h4>From Your Inbox</h4>
            <div className="email-refs">
                {dash.emails.map((e, i) => {
                    const openable = !!(e.emailId && onOpenEmail);
                    return (
                        <div className={`email-ref ${openable ? 'openable' : ''}`} key={i}
                            title={openable ? 'Read this email in the app' : undefined}
                            onClick={() => openable && onOpenEmail!(e.emailId!)}>
                            <span className="email-ref-subject">
                                <Emoji char="✉️" size={14} /> {e.subject}
                            </span>
                            <span className="email-ref-sender">{e.senderName}{openable ? ' →' : ''}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    </footer>
);

// ============================================
// NORMALIZATION
// ============================================

export function normalizeDashboard(dash: TopicDashboard): TopicDashboard {
    const arr = <T,>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
    const c = dash.content || ({} as TopicDashboard['content']);
    return {
        ...dash,
        icon: dash.icon || '📰',
        category: dash.category || 'General',
        template: dash.template || 'pulse',
        content: {
            headline: c.headline || dash.topic || 'Briefing',
            overview: c.overview || '',
            sentiment: c.sentiment === 'Positive' || c.sentiment === 'Negative' ? c.sentiment : 'Neutral',
            stats: arr(c.stats).filter(s => s && s.value != null && s.label != null),
            key_points: arr(c.key_points).filter(k => k && k.text),
            timeline: arr(c.timeline).filter(t => t && t.text),
            quotes: arr(c.quotes).filter(q => q && q.text),
            action_items: arr(c.action_items).filter(Boolean),
            glossary: arr(c.glossary).filter(g => g && g.term),
            web_context: arr(c.web_context).filter(w => w && w.text),
            fun_fact: c.fun_fact,
        },
        sources: arr(dash.sources).filter(s => s && s.url),
        images: arr(dash.images).filter(i => i && i.url),
        emails: arr(dash.emails).filter(e => e && (e.subject || e.senderName)),
    };
}

// ============================================
// TEMPLATE LAYOUTS — single reading flow with images
// separating blocks of text
// ============================================

const DashHero = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => (
    <div className="dash-hero">
        <div className="dash-hero-meta">
            <span className="dash-icon"><Emoji char={dash.icon} size={26} /></span>
            <span className="dash-category">{dash.category}</span>
            <TemplateBadge template={dash.template} />
            <SentimentPill sentiment={dash.content.sentiment} />
        </div>
        <h1 className="dash-headline">{richText(dash.content.headline, hl)}</h1>
        <p className="dash-overview">{richText(dash.content.overview, hl)}</p>
    </div>
);

const PulseLayout = (p: SectionProps) => (
    <>
        <DashHero dash={p.dash} hl={p.hl} />
        <Breather img={p.dash.images[0]} openExternal={p.openExternal} />
        <StatTiles dash={p.dash} />
        <KeyPoints dash={p.dash} hl={p.hl} />
        <Breather img={p.dash.images[1]} openExternal={p.openExternal} />
        <WebContext {...p} />
        <ImageStrip images={p.dash.images} openExternal={p.openExternal} skip={2} />
    </>
);

const EditorialLayout = (p: SectionProps) => (
    <>
        <Breather img={p.dash.images[0]} openExternal={p.openExternal} />
        <DashHero dash={p.dash} hl={p.hl} />
        <Quotes dash={p.dash} hl={p.hl} />
        <StatTiles dash={p.dash} />
        <KeyPoints dash={p.dash} hl={p.hl} />
        <Breather img={p.dash.images[1]} openExternal={p.openExternal} />
        <WebContext {...p} />
        <ImageStrip images={p.dash.images} openExternal={p.openExternal} skip={2} />
    </>
);

const TimelineLayout = (p: SectionProps) => (
    <>
        <DashHero dash={p.dash} hl={p.hl} />
        <Breather img={p.dash.images[0]} openExternal={p.openExternal} />
        <StatTiles dash={p.dash} />
        <TimelineSection dash={p.dash} hl={p.hl} />
        <Breather img={p.dash.images[1]} openExternal={p.openExternal} />
        <KeyPoints dash={p.dash} hl={p.hl} title="Highlights" />
        <WebContext {...p} />
        <ImageStrip images={p.dash.images} openExternal={p.openExternal} skip={2} />
    </>
);

const SpotlightLayout = (p: SectionProps) => {
    const heroImg = p.dash.images[0];
    return (
        <>
            <div className={`spotlight-hero ${heroImg ? 'has-img' : ''}`}>
                {heroImg && <img className="spotlight-bg" src={heroImg.url} alt=""
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                <div className="spotlight-hero-content">
                    <DashHero dash={p.dash} hl={p.hl} />
                </div>
            </div>
            <FunFact dash={p.dash} hl={p.hl} />
            <KeyPoints dash={p.dash} hl={p.hl} />
            <Breather img={p.dash.images[1]} openExternal={p.openExternal} />
            <StatTiles dash={p.dash} />
            <WebContext {...p} />
            <ImageStrip images={p.dash.images} openExternal={p.openExternal} skip={2} />
        </>
    );
};

const MatrixLayout = (p: SectionProps) => (
    <>
        <DashHero dash={p.dash} hl={p.hl} />
        <Breather img={p.dash.images[0]} openExternal={p.openExternal} />
        <StatTiles dash={p.dash} />
        {p.dash.content.key_points?.length > 0 && (
            <section className="dash-section">
                <h3 className="section-title">The Matrix</h3>
                <div className="matrix-grid">
                    {p.dash.content.key_points.map((pt, i) => (
                        <div className={`matrix-cell ${pt.is_sponsored ? 'sponsored' : ''}`} key={i}
                            style={{ animationDelay: `${i * 0.04}s` }}>
                            {(pt.tag || pt.is_sponsored) && (
                                <span className={`point-tag ${pt.is_sponsored ? 'ad-tag' : ''}`}>
                                    {pt.is_sponsored ? 'Ad' : pt.tag}
                                </span>
                            )}
                            <p>{richText(pt.text, p.hl)}</p>
                        </div>
                    ))}
                </div>
            </section>
        )}
        <Breather img={p.dash.images[1]} openExternal={p.openExternal} />
        <WebContext {...p} />
        <ImageStrip images={p.dash.images} openExternal={p.openExternal} skip={2} />
    </>
);

// ============================================
// FULL DASHBOARD VIEW
// ============================================

interface DashboardDetailProps {
    dash: TopicDashboard;
    highlightsEnabled: boolean;
    openExternal: (url: string) => void;
    onOpenEmail?: (emailId: string) => void;
    onBack: () => void;
}

export const DashboardDetail = ({ dash: rawDash, highlightsEnabled, openExternal, onOpenEmail, onBack }: DashboardDetailProps) => {
    const dash = normalizeDashboard(rawDash);
    const p: SectionProps = { dash, hl: highlightsEnabled, openExternal, onOpenEmail };

    // Always open a dashboard from the top, not wherever the grid was scrolled
    useEffect(() => {
        document.querySelector('.main-content')?.scrollTo({ top: 0 });
    }, [dash.id]);

    return (
        <div className={`dashboard-detail dash--${dash.template} reader-surface`}>
            <button className="back-btn" onClick={onBack}>← All Topics</button>
            {dash.template === 'pulse' && <PulseLayout {...p} />}
            {dash.template === 'editorial' && <EditorialLayout {...p} />}
            {dash.template === 'timeline' && <TimelineLayout {...p} />}
            {dash.template === 'spotlight' && <SpotlightLayout {...p} />}
            {dash.template === 'matrix' && <MatrixLayout {...p} />}
            <SourcesFooter dash={dash} openExternal={openExternal} onOpenEmail={onOpenEmail} />
        </div>
    );
};

// ============================================
// GRID CARD
// ============================================

export const DashboardCard = ({ dash: rawDash, index, onClick }: { dash: TopicDashboard; index: number; onClick: () => void }) => {
    const dash = normalizeDashboard(rawDash);
    const img = dash.images[0];
    return (
        <article className="topic-card" style={{ animationDelay: `${index * 0.07}s` }} onClick={onClick}>
            {img && (
                <div className="topic-card-img">
                    <img src={img.url} alt="" loading="lazy"
                        onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
                </div>
            )}
            <div className="topic-card-body">
                <div className="topic-card-meta">
                    <span className="dash-icon"><Emoji char={dash.icon} size={20} /></span>
                    <span className="dash-category">{dash.category}</span>
                    <TemplateBadge template={dash.template} />
                    <SentimentPill sentiment={dash.content.sentiment} />
                </div>
                <h2 className="topic-card-headline">{dash.content.headline.replace(/==/g, '')}</h2>
                <p className="topic-card-overview">{dash.content.overview.replace(/==|\*\*/g, '')}</p>
                {dash.content.stats?.length > 0 && (
                    <div className="topic-card-stats">
                        {dash.content.stats.slice(0, 3).map((s, i) => (
                            <div key={i} className="mini-stat">
                                <span className="mini-stat-value">{s.value}</span>
                                <span className="mini-stat-label">{s.label}</span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="topic-card-foot">
                    <span>{dash.emails.length} email{dash.emails.length !== 1 ? 's' : ''}</span>
                    <span>{dash.sources.length} source{dash.sources.length !== 1 ? 's' : ''}</span>
                    <span className="open-hint">Open dashboard →</span>
                </div>
            </div>
        </article>
    );
};
