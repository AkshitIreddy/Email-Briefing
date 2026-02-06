import { useEffect, useMemo, useState } from 'react';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { loadEmojiShape } from '@tsparticles/shape-emoji';
import type { ISourceOptions } from '@tsparticles/engine';

interface ParticlesBackgroundProps {
    mode?: 'simple' | 'snow' | 'nebula';
}

export const ParticlesBackground = ({ mode = 'simple' }: ParticlesBackgroundProps) => {
    const [init, setInit] = useState(false);

    useEffect(() => {
        initParticlesEngine(async (engine) => {
            await loadSlim(engine);
            await loadEmojiShape(engine);
        }).then(() => {
            setInit(true);
        });
    }, []);

    const options: ISourceOptions = useMemo(() => {
        // Mode 1: Emoji Snow (User Request: "snowflakes that look like the emoji")
        if (mode === 'snow') {
            return {
                background: {
                    color: { value: 'transparent' },
                },
                particles: {
                    shape: {
                        type: 'emoji',
                        options: {
                            emoji: {
                                value: ['❄️', '❅', '❆'],
                            },
                        },
                    },
                    color: {
                        value: '#ffffff',
                    },
                    move: {
                        direction: 'bottom',
                        enable: true,
                        outModes: {
                            default: 'out',
                        },
                        random: false,
                        speed: 2,
                        straight: false,
                    },
                    number: {
                        density: {
                            enable: true,
                        },
                        value: 40,
                    },
                    opacity: {
                        value: { min: 0.6, max: 0.9 },
                    },
                    size: {
                        value: { min: 10, max: 20 },
                    },
                    wobble: {
                        enable: true,
                        distance: 10,
                        speed: 10
                    },
                    zIndex: {
                        value: { min: 0, max: 100 }
                    }
                },
                detectRetina: true,
            };
        }

        // Mode 2: Cyber Nebula (Fluid-like via interconnected animated particles)
        if (mode === 'nebula') {
            return {
                background: {
                    color: { value: 'transparent' },
                },
                particles: {
                    color: {
                        value: ['#06b6d4', '#8b5cf6', '#ec4899'],
                    },
                    links: {
                        color: '#8b5cf6',
                        distance: 150,
                        enable: true,
                        opacity: 0.3,
                        width: 1,
                        triangles: {
                            enable: true,
                            opacity: 0.05,
                        }
                    },
                    move: {
                        enable: true,
                        speed: 1.5,
                        direction: 'none',
                        random: false,
                        straight: false,
                        outModes: 'bounce',
                    },
                    number: {
                        value: 60,
                        density: {
                            enable: true,
                        },
                    },
                    opacity: {
                        value: { min: 0.3, max: 0.7 },
                    },
                    shape: {
                        type: 'circle',
                    },
                    size: {
                        value: { min: 1, max: 3 },
                    },
                },
                interactivity: {
                    events: {
                        onHover: {
                            enable: true,
                            mode: 'grab',
                        },
                    },
                    modes: {
                        grab: {
                            distance: 200,
                            links: {
                                opacity: 0.5,
                            },
                        },
                    },
                },
                detectRetina: true,
            };
        }

        // Mode 3: Simple (Original)
        return {
            background: {
                color: { value: 'transparent' }, // Handled by CSS
            },
            fpsLimit: 60,
            particles: {
                color: {
                    value: ['#06b6d4', '#8b5cf6', '#ec4899'],
                },
                links: {
                    color: '#06b6d4',
                    distance: 150,
                    enable: true,
                    opacity: 0.15,
                    width: 1,
                },
                move: {
                    enable: true,
                    speed: 0.8,
                    direction: 'none',
                    random: true,
                    straight: false,
                    outModes: {
                        default: 'bounce',
                    },
                },
                number: {
                    density: {
                        enable: true,
                        width: 1920,
                        height: 1080,
                    },
                    value: 40,
                },
                opacity: {
                    value: { min: 0.1, max: 0.4 },
                    animation: {
                        enable: true,
                        speed: 0.5,
                        sync: false,
                    },
                },
                shape: {
                    type: 'circle',
                },
                size: {
                    value: { min: 1, max: 4 },
                },
            },
            detectRetina: true,
        };
    }, [mode]);

    if (!init) return null;

    return (
        <Particles
            id="tsparticles"
            options={options}
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                zIndex: -1,
                pointerEvents: 'none',
            }}
        />
    );
};
