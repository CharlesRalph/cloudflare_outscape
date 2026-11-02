import {Hono} from "hono";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {Env} from "../types";
import {toStatusCode} from "../types";
import {cachedJson} from "../cache";

const availability = new Hono<{ Bindings: Env }>();

/**
 * GET /api/availability
 *
 * Spec-correct query params:
 *   productCode * — Rezdy product code (e.g. PYYHYR)
 *   startTimeLocal * — yyyy-MM-dd HH:mm:ss (preferred over ISO startTime)
 *   endTimeLocal * — yyyy-MM-dd HH:mm:ss
 *   minAvailability — integer, total guests (spec param name, not "qty")
 *
 * Returns sessions with seatsAvailable and priceOptions.
 * Called when the user lands on step 2 after confirming guest count in step 1.
 */

export type RoomGrade = 'premium' | 'superior';
export type ExperienceDuration = '4day' | '5day';
export type Departure = 'essendon' | 'launceston';

export interface Product {
    productCode: string;
    roomGrade: RoomGrade;
    duration: ExperienceDuration;
    departure: Departure;
}

//Production product codes
export const PRODUCTS: Product[] = [
    // 4-day Melbourne
    {
        productCode: 'PQUTX3',
        roomGrade: 'premium',
        duration: '4day',
        departure: 'essendon'
    },
    {
        productCode: 'PYYHYR',
        roomGrade: 'superior',
        duration: '4day',
        departure: 'essendon'
    },
    // 4-day Tasmania
    {
        productCode: 'PTYZRD',
        roomGrade: 'premium',
        duration: '4day',
        departure: 'launceston'
    },
    {
        productCode: 'P40ACD',
        roomGrade: 'superior',
        duration: '4day',
        departure: 'launceston'
    },
    // 5-day Melbourne
    {
        productCode: 'PJ1DJQ',
        roomGrade: 'premium',
        duration: '5day',
        departure: 'essendon'
    },
    {
        productCode: 'P03PSQ',
        roomGrade: 'superior',
        duration: '5day',
        departure: 'essendon'
    },
    // 5-day Tasmania
    {
        productCode: 'P4S6YG',
        roomGrade: 'premium',
        duration: '5day',
        departure: 'launceston'
    },
    {
        productCode: 'P0N5DN',
        roomGrade: 'superior',
        duration: '5day',
        departure: 'launceston'
    },
];

const productCodeFmt = /^[A-Z0-9_-]{3,50}$/i;

type RezdyAvailabilitySession = {
    id?: number;
    productCode?: string;
    startTime?: string;
    endTime?: string;
    startTimeLocal?: string;
    endTimeLocal?: string;
    allDay?: boolean;
    seats?: number;
    seatsAvailable?: number;
    priceOptions?: Array<Record<string, unknown>>;
    [key: string]: unknown;
};

type RezdyAvailabilityResponse = {
    requestStatus?: {
        success?: boolean;
        version?: string;
        [key: string]: unknown;
    };
    sessions?: RezdyAvailabilitySession[];
    [key: string]: unknown;
};

type ProductAvailability = {
    productCode: string;
    roomGrade: RoomGrade;
    availability: RezdyAvailabilityResponse;
};

type UpcomingAvailability = {
    duration: ExperienceDuration;
    label: string;
    availability: RezdyAvailabilitySession | null;
};

// const localTimeFmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function formatDateTimeLocal(date: Date, endOfDay = false): string {
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const time = endOfDay ? "23:59:59" : "00:00:00";

    return `${year}-${month}-${day} ${time}`;
}

function formatDateTimeLocalWithTime(date: Date): string {
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hours = pad2(date.getHours());
    const minutes = pad2(date.getMinutes());
    const seconds = pad2(date.getSeconds());

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getUpcomingAvailabilityWindow(): { startTimeLocal: string; endTimeLocal: string } {
    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + 3);

    return {
        startTimeLocal: formatDateTimeLocalWithTime(start),
        endTimeLocal: formatDateTimeLocalWithTime(end),
    };
}

function getAvailabilityWindow(month?: string): { startTimeLocal: string; endTimeLocal: string } | { error: string } {
    if (month) {
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return {error: 'month must be in format "yyyy-MM".'};
        }

        const [yearRaw, monthRaw] = month.split("-");
        const year = Number(yearRaw);
        const monthNumber = Number(monthRaw);

        if (monthNumber < 1 || monthNumber > 12) {
            return {error: "month must be between 01 and 12."};
        }

        const start = new Date(year, monthNumber - 1, 1);
        const end = new Date(year, monthNumber, 0);

        return {
            startTimeLocal: formatDateTimeLocal(start),
            endTimeLocal: formatDateTimeLocal(end, true),
        };
    }

    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);

    return {
        startTimeLocal: formatDateTimeLocal(start),
        endTimeLocal: formatDateTimeLocal(end, true),
    };
}

function getSessionMergeKey(session: RezdyAvailabilitySession): string {
    return [
        session.startTime ?? "",
        session.endTime ?? "",
        session.startTimeLocal ?? "",
        session.endTimeLocal ?? "",
    ].join("::");
}

function getSessionSeats(session: RezdyAvailabilitySession): number {
    return typeof session.seats === "number" ? session.seats : 0;
}

function getSessionSeatsAvailable(session: RezdyAvailabilitySession): number {
    return typeof session.seatsAvailable === "number"
        ? session.seatsAvailable
        : 0;
}

function getProductRoomGrade(productCode: string, products: Product[]
): RoomGrade | null {
    return products.find((product) => product.productCode === productCode)?.roomGrade ?? null;
}

function getSessionStartTimestamp(session: RezdyAvailabilitySession): number {
    const startTime = session.startTimeLocal ?? session.startTime;

    if (!startTime || typeof startTime !== "string") {
        return Number.POSITIVE_INFINITY;
    }

    return new Date(startTime.replace(" ", "T")).getTime();
}

function getDurationLabel(duration: ExperienceDuration): string {
    return duration === "4day"
        ? "The essential experience"
        : "The complete immersion";
}

function getFirstUpcomingSession(availability: RezdyAvailabilityResponse): RezdyAvailabilitySession | null {
    const sessions = Array.isArray(availability.sessions)
        ? availability.sessions
        : [];

    return sessions
        .filter((session) => getSessionSeatsAvailable(session) > 0)
        .sort((a, b) => getSessionStartTimestamp(a) - getSessionStartTimestamp(b))[0] ?? null;
}

async function getProductAvailability(client: RezdyClient, product: Product, baseParams: Record<string, string>): Promise<ProductAvailability> {
    try {
        const data = await client.get<RezdyAvailabilityResponse>("/availability", {
            ...baseParams,
            productCode: product.productCode,
        });

        return {
            productCode: product.productCode,
            roomGrade: product.roomGrade,
            availability: data,
        };
    } catch (err) {
        if (err instanceof RezdyError && err.status === 422) {
            return {
                productCode: product.productCode,
                roomGrade: product.roomGrade,
                availability: {sessions: []},
            };
        }

        throw err;
    }
}

function mergeProductAvailabilitySessions(products: ProductAvailability[]): RezdyAvailabilityResponse {
    const [baseProduct, ...otherProducts] = products;

    if (!baseProduct) {
        return {
            requestStatus: {
                success: true,
                version: "v1",
            },
            sessions: [],
        };
    }

    const baseSessions = Array.isArray(baseProduct.availability.sessions)
        ? baseProduct.availability.sessions
        : [];

    const otherSessionsByProduct = otherProducts.map((product) => {
        const sessions = Array.isArray(product.availability.sessions)
            ? product.availability.sessions
            : [];

        return {
            product,
            sessionsByKey: new Map(
                sessions.map((session) => [getSessionMergeKey(session), session])
            ),
        };
    });

    return {
        requestStatus: baseProduct.availability.requestStatus ?? {
            success: true,
            version: "v1",
        },
        sessions: baseSessions.map((baseSession) => {
            const {priceOptions, ...baseSessionWithoutPriceOptions} = baseSession;
            const key = getSessionMergeKey(baseSession);

            const productSessions = [
                {
                    roomGrade: baseProduct.roomGrade,
                    productCode: baseProduct.productCode,
                    sessionId: baseSession.id,
                    seats: getSessionSeats(baseSession),
                    seatsAvailable: getSessionSeatsAvailable(baseSession),
                },
            ];

            const matchedOtherSessions = otherSessionsByProduct
                .map(({product, sessionsByKey}) => {
                    const session = sessionsByKey.get(key);

                    if (!session) {
                        return null;
                    }

                    return {
                        roomGrade: product.roomGrade,
                        productCode: product.productCode,
                        sessionId: session.id,
                        seats: getSessionSeats(session),
                        seatsAvailable: getSessionSeatsAvailable(session),
                    };
                })
                .filter((session): session is {
                    roomGrade: RoomGrade;
                    productCode: string;
                    sessionId: number | undefined;
                    seats: number;
                    seatsAvailable: number;
                } => session !== null);

            productSessions.push(...matchedOtherSessions);

            // const totalSeats = productSessions.reduce(
            //     (sum, session) => sum + session.seats,
            //     0
            // );

            const seatsAvailableByRoomGrade = productSessions.reduce(
                (acc, session) => {
                    acc[session.roomGrade] = Math.max(
                        acc[session.roomGrade] ?? 0,
                        session.seatsAvailable
                    );

                    return acc;
                },
                {} as Record<RoomGrade, number>
            );

            const totalSeatsAvailable = Object.values(seatsAvailableByRoomGrade).reduce(
                (sum, seatsAvailable) => sum + seatsAvailable,
                0
            );

            // const totalSeatsAvailable = productSessions.reduce(
            //     (sum, session) => sum + session.seatsAvailable,
            //     0
            // )
            return {
                ...baseSessionWithoutPriceOptions,
                productCode: products.map((product) => product.productCode).join(","),
                seats: totalSeatsAvailable,
                seatsAvailable: totalSeatsAvailable,
                productSessions,
            };
        }),
    };
}

availability.get("/upcoming", async (c) => {
    const window = getUpcomingAvailabilityWindow();

    const baseParams: Record<string, string> = {
        startTimeLocal: window.startTimeLocal,
        endTimeLocal: window.endTimeLocal,
    };

    try {
        return cachedJson(
            c, {
                ttlSeconds: 60 * 5,
                cacheKey: '/api/availability/upcoming'
            },
            async () => {
                const client = new RezdyClient(c.env);
                const upcoming = await Promise.all(
                    (["4day", "5day"] as const).map(async (duration): Promise<UpcomingAvailability> => {
                        const durationProducts = PRODUCTS.filter((product) => product.duration === duration);

                        const products = await Promise.all(
                            durationProducts.map((product) => getProductAvailability(client, product, baseParams))
                        );

                        const mergedAvailability = mergeProductAvailabilitySessions(products);
                        const firstSession = getFirstUpcomingSession(mergedAvailability);

                        return {
                            duration,
                            label: getDurationLabel(duration),
                            availability: firstSession,
                        };
                    })
                );

                return {
                    startTimeLocal: window.startTimeLocal,
                    endTimeLocal: window.endTimeLocal,
                    rangeMonths: 3,
                    upcoming,
                };
            }
        )
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch upcoming availability.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        throw err;
    }
});

availability.get("/products", async (c) => {
    const {
        productsCode,
        month,
        minAvailability,
    } = c.req.query();

    if (!productsCode) {
        return c.json({error: "Missing required param: productsCode."}, 400);
    }

    const productCodes = productsCode
        .split(",")
        .map((productCode) => productCode.trim())
        .filter(Boolean);

    if (productCodes.length < 2) {
        return c.json(
            {error: "productsCode must contain at least two product codes."},
            400
        );
    }

    if (productCodes.some((productCode) => !productCodeFmt.test(productCode))) {
        return c.json({error: "Invalid product code format."}, 400);
    }

    const window = getAvailabilityWindow(month);
    if ("error" in window) {
        return c.json({error: window.error}, 400);
    }

    const baseParams: Record<string, string> = {
        startTimeLocal: window.startTimeLocal,
        endTimeLocal: window.endTimeLocal,
    };

    if (minAvailability) {
        const qty = parseInt(minAvailability, 10);
        if (isNaN(qty) || qty < 1 || qty > 50) {
            return c.json(
                {error: "minAvailability must be a number between 1 and 50."},
                400
            );
        }
        baseParams.minAvailability = String(qty);
    }

    try {
        const client = new RezdyClient(c.env);

        const products = await Promise.all(
            productCodes.map(async (productCode): Promise<ProductAvailability> => {
                const roomGrade = getProductRoomGrade(productCode, PRODUCTS);

                if (!roomGrade) {
                    throw new Error(`No roomGrade configured for productCode ${productCode}.`);
                }

                try {
                    const data = await client.get<RezdyAvailabilityResponse>("/availability", {
                        ...baseParams,
                        productCode,
                    });

                    return {
                        productCode,
                        roomGrade,
                        availability: data,
                    };
                } catch (err) {
                    if (err instanceof RezdyError && err.status === 422) {
                        return {
                            productCode,
                            roomGrade,
                            availability: {sessions: []},
                        };
                    }

                    throw err;
                }
            })
        );

        const mergedAvailability = mergeProductAvailabilitySessions(products);

        return c.json({
            startTimeLocal: window.startTimeLocal,
            endTimeLocal: window.endTimeLocal,
            availability: mergedAvailability,
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch availability.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        throw err;
    }
});

// availability.get("/products", async (c) => {
//     const {
//         productsCode,
//         month,
//         minAvailability,
//     } = c.req.query();
//
//     if (!productsCode) {
//         return c.json({error: "Missing required param: productsCode."}, 400);
//     }
//
//     const productCodes = productsCode
//         .split(",")
//         .map((productCode) => productCode.trim())
//         .filter(Boolean);
//
//     if (productCodes.length < 2) {
//         return c.json(
//             {error: "productsCode must contain at least two product codes."},
//             400
//         );
//     }
//
//     if (productCodes.some((productCode) => !productCodeFmt.test(productCode))) {
//         return c.json({error: "Invalid product code format."}, 400);
//     }
//
//     const window = getAvailabilityWindow(month);
//     if ("error" in window) {
//         return c.json({error: window.error}, 400);
//     }
//
//     const baseParams: Record<string, string> = {
//         startTimeLocal: window.startTimeLocal,
//         endTimeLocal: window.endTimeLocal,
//     };
//
//     if (minAvailability) {
//         const qty = parseInt(minAvailability, 10);
//         if (isNaN(qty) || qty < 1 || qty > 50) {
//             return c.json(
//                 {error: "minAvailability must be a number between 1 and 50."},
//                 400
//             );
//         }
//         baseParams.minAvailability = String(qty);
//     }
//
//     try {
//         const client = new RezdyClient(c.env);
//
//         const products = await Promise.all(
//             productCodes.map(async (productCode) => {
//                 try {
//                     const data = await client.get("/availability", {
//                         ...baseParams,
//                         productCode,
//                     });
//
//                     return {
//                         productCode,
//                         availability: data,
//                     };
//                 } catch (err) {
//                     if (err instanceof RezdyError && err.status === 422) {
//                         return {
//                             productCode,
//                             availability: {sessions: []},
//                         };
//                     }
//
//                     throw err;
//                 }
//             })
//         );
//
//         return c.json({
//             startTimeLocal: window.startTimeLocal,
//             endTimeLocal: window.endTimeLocal,
//             products,
//         });
//     } catch (err) {
//         if (err instanceof RezdyError) {
//             return c.json(
//                 {error: "Failed to fetch availability.", detail: err.body},
//                 toStatusCode(err.status)
//             );
//         }
//
//         throw err;
//     }
// });

availability.get("/product", async (c) => {
    const {
        productCode,
        month,
        minAvailability,
    } = c.req.query();

    if (!productCode) {
        return c.json({error: "Missing required param: productCode."}, 400);
    }

    if (!productCodeFmt.test(productCode)) {
        return c.json({error: "Invalid product code format."}, 400);
    }

    const window = getAvailabilityWindow(month);
    if ("error" in window) {
        return c.json({error: window.error}, 400);
    }

    const params: Record<string, string> = {
        productCode,
        startTimeLocal: window.startTimeLocal,
        endTimeLocal: window.endTimeLocal,
    };

    if (minAvailability) {
        const qty = parseInt(minAvailability, 10);
        if (isNaN(qty) || qty < 1 || qty > 50) {
            return c.json(
                {error: "minAvailability must be a number between 1 and 50."},
                400
            );
        }
        params.minAvailability = String(qty);
    }

    try {
        const client = new RezdyClient(c.env);
        const data = await client.get("/availability", params);

        return c.json({
            productCode,
            startTimeLocal: window.startTimeLocal,
            endTimeLocal: window.endTimeLocal,
            availability: data,
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            if (err.status === 422) {
                return c.json(
                    {
                        productCode,
                        startTimeLocal: window.startTimeLocal,
                        endTimeLocal: window.endTimeLocal,
                        availability: {sessions: []},
                    },
                    200
                );
            }

            return c.json(
                {error: "Failed to fetch availability.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        throw err;
    }
});

availability.get("/", async (c) => {
    const {
        productCode,
        startTimeLocal,
        endTimeLocal,
        minAvailability,
    } = c.req.query();

    // Validate required params
    const missing: string[] = [];
    if (!productCode) missing.push("productCode");
    if (!startTimeLocal) missing.push("startTimeLocal");
    if (!endTimeLocal) missing.push("endTimeLocal");

    if (missing.length) {
        return c.json(
            {error: `Missing required params: ${missing.join(", ")}.`},
            400
        );
    }

    if (!/^[A-Z0-9_-]{3,50}$/i.test(productCode)) {
        return c.json({error: "Invalid product code format."}, 400);
    }

    // Validate local time format: yyyy-MM-dd HH:mm:ss
    const localTimeFmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!localTimeFmt.test(startTimeLocal) || !localTimeFmt.test(endTimeLocal)) {
        return c.json(
            {
                error:
                    'startTimeLocal and endTimeLocal must be in format "yyyy-MM-dd HH:mm:ss".',
            },
            400
        );
    }

    // minAvailability is optional but if provided must be a sane number
    const params: Record<string, string> = {
        productCode,
        startTimeLocal,
        endTimeLocal,
    };

    if (minAvailability) {
        const qty = parseInt(minAvailability, 10);
        if (isNaN(qty) || qty < 1 || qty > 50) {
            return c.json(
                {error: "minAvailability must be a number between 1 and 50."},
                400
            );
        }
        params.minAvailability = String(qty);
    }

    try {
        const client = new RezdyClient(c.env);
        const data = await client.get("/availability", params);
        return c.json(data);
    } catch (err) {
        if (err instanceof RezdyError) {
            if (err.status === 422) {
                return c.json(
                    {error: "No availability for the selected dates.", sessions: []},
                    200
                );
            }
            return c.json(
                {error: "Failed to fetch availability.", detail: err.body},
                toStatusCode(err.status)
            );
        }
        throw err;
    }
});

export default availability;


//staging product codes
// export const PRODUCTS: Product[] = [
//     // 4-day Melbourne
//     {
//         productCode: 'PQBNYP',
//         roomGrade: 'premium',
//         duration: '4day'
//     },
//     {
//         productCode: 'PFE3H3',
//         roomGrade: 'superior',
//         duration: '4day'
//     },
//     // 4-day Tasmania
//     {
//         productCode: 'PSJEXB',
//         roomGrade: 'premium',
//         duration: '4day'
//     },
//     {
//         productCode: 'PQ9VCN',
//         roomGrade: 'superior',
//         duration: '4day'
//     },
//     // 5-day Melbourne
//     {
//         productCode: 'PT7QKK',
//         roomGrade: 'premium',
//         duration: '5day'
//     },
//     {
//         productCode: 'PLXER0',
//         roomGrade: 'superior',
//         duration: '5day'
//     },
//     // 5-day Tasmania
//     {
//         productCode: 'P5GDTS',
//         roomGrade: 'premium',
//         duration: '5day'
//     },
//     {
//         productCode: 'PKWPCE',
//         roomGrade: 'superior',
//         duration: '5day'
//     },
// ];
