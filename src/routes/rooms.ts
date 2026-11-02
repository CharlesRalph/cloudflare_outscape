import {Hono} from "hono";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {Env} from "../types";
import {toStatusCode} from "../types";

const rooms = new Hono<{ Bindings: Env }>();

const productCodeFmt = /^[A-Z0-9_-]{3,50}$/i;

type RoomCategory = "superior" | "premium";

type RezdyPriceOption = {
    id?: number;
    label?: string;
    price?: number;
    seatsUsed?: number;
    productCode?: string;
    [key: string]: unknown;
};

type RezdyProduct = {
    productCode?: string;
    code?: string;
    seatsAvailable?: number;
    priceOptions?: RezdyPriceOption[];
    [key: string]: unknown;
};

type RezdyProductResponse = {
    product?: RezdyProduct;
    [key: string]: unknown;
};

type WebflowAsset = {
    fileId?: string;
    url?: string;
    alt?: string | null;
};

type WebflowRoomFieldData = {
    displayname?: string | null;
    productcode?: string;
    roomlabel?: string;
    roomcategory?: string;
    gallery?: WebflowAsset[];
    "room-snapshot"?: string | null;
    "best-for"?: string | null;
    views?: string | null;
    slotcalculation?: number | null;
    "room-features-2"?: string[];
    [key: string]: unknown;
};

type WebflowRoomFeatureFieldData = {
    name?: string | null;
    displayname?: string | null;
    title?: string | null;
    icon?: WebflowAsset | null;
    [key: string]: unknown;
};

type WebflowRoomFeatureItem = {
    id?: string;
    fieldData?: WebflowRoomFeatureFieldData;
    [key: string]: unknown;
};

type WebflowRoomItem = {
    id?: string;
    fieldData?: WebflowRoomFieldData;
    [key: string]: unknown;
};

// type WebflowItemsResponse = {
//     items?: WebflowRoomItem[];
//     [key: string]: unknown;
// };

type RoomFeature = {
    name: string;
    iconUrl: string | null;
};

type NormalizedCmsRoom = {
    id: string | null;
    displayName: string | null;
    productCode: string;
    roomLabel: string;
    roomCategory: RoomCategory | null;
    gallery: WebflowAsset[];
    roomSnapshot: string | null;
    bestFor: string | null;
    views: string | null;
    slotCalculation: number | null;
    roomFeatureIds: string[];
    roomFeatures: RoomFeature[];
};

function normalizeText(value: string): string {
    return value.trim().toLowerCase();
}

function normalizeRoomCategory(value?: string): RoomCategory | null {
    if (!value) return null;

    const normalized = normalizeText(value);

    if (normalized === "superior") return "superior";
    if (normalized === "premium") return "premium";

    return null;
}

function normalizeNullableString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}


function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    return value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
}

function getRoomFeatureName(item: WebflowRoomFeatureItem): string | null {
    const fieldData = item.fieldData;

    return (
        normalizeNullableString(fieldData?.["feature-name"]) ??
        normalizeNullableString(fieldData?.name) ??
        normalizeNullableString(fieldData?.displayname) ??
        normalizeNullableString(fieldData?.title)
    );
}

function getRoomFeatureIconUrl(item: WebflowRoomFeatureItem): string | null {
    const icon = item.fieldData?.icon;

    return icon && typeof icon === "object"
        ? normalizeNullableString(icon.url)
        : null;
}

function buildRoomFeaturesById(items: WebflowRoomFeatureItem[]): Map<string, RoomFeature> {
    return new Map(
        items
            .map((item): [string, RoomFeature] | null => {
                if (!item.id) return null;

                const featureName = getRoomFeatureName(item);
                if (!featureName) return null;

                return [
                    item.id,
                    {
                        name: featureName,
                        iconUrl: getRoomFeatureIconUrl(item),
                    },
                ];
            })
            .filter((entry): entry is [string, RoomFeature] => entry !== null)
    );
}

function getProductFromResponse(data: RezdyProductResponse): RezdyProduct {
    if (data.product && typeof data.product === "object") {
        return data.product;
    }

    return data as RezdyProduct;
}

function getPriceOptions(product: RezdyProduct): RezdyPriceOption[] {
    return Array.isArray(product.priceOptions) ? product.priceOptions : [];
}

// function getSeatsAvailable(product: RezdyProduct): number | null {
//     return typeof product.seatsAvailable === "number"
//         ? product.seatsAvailable
//         : null;
// }

function getPriceOptionProductCode(
    priceOption: RezdyPriceOption,
    fallbackProductCode: string
): string {
    return typeof priceOption.productCode === "string"
        ? priceOption.productCode
        : fallbackProductCode;
}

function getCmsRoomMatchKey(productCode: string, roomLabel: string): string {
    return `${normalizeText(productCode)}::${normalizeText(roomLabel)}`;
}

function normalizeCmsRoom(item: WebflowRoomItem): NormalizedCmsRoom | null {
    const fieldData = item.fieldData;

    if (!fieldData?.productcode || !fieldData.roomlabel) {
        return null;
    }

    return {
        id: typeof item.id === "string" ? item.id : null,
        displayName:
            typeof fieldData.displayname === "string" && fieldData.displayname.trim()
                ? fieldData.displayname.trim()
                : null,
        productCode: fieldData.productcode.trim(),
        roomLabel: fieldData.roomlabel.trim(),
        roomCategory: normalizeRoomCategory(fieldData.roomcategory),
        gallery: Array.isArray(fieldData.gallery) ? fieldData.gallery : [],
        roomSnapshot: normalizeNullableString(fieldData["room-snapshot"]),
        bestFor: normalizeNullableString(fieldData["best-for"]),
        views: normalizeNullableString(fieldData.views),
        slotCalculation:
            typeof fieldData.slotcalculation === "number" && Number.isFinite(fieldData.slotcalculation)
                ? fieldData.slotcalculation
                : null,
        roomFeatureIds: normalizeStringArray(fieldData["room-features-2"]),
        roomFeatures: [],
    };
}


async function fetchWebflowCollection<T>(
    collectionId: string,
    token: string
): Promise<T[]> {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100`;

    const res = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Webflow API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { items?: T[] };
    return Array.isArray(data.items) ? data.items : [];
}

async function fetchWebflowRooms(env: Env): Promise<NormalizedCmsRoom[]> {
    const roomsCollectionId = env.WEBFLOW_ROOMS_COLLECTION_ID;
    const roomFeaturesCollectionId = env.WEBFLOW_ROOM_FEATURES_COLLECTION_ID;
    const token = env.WEBFLOW_API_TOKEN;

    if (!roomsCollectionId) {
        throw new Error("WEBFLOW_ROOMS_COLLECTION_ID is not configured.");
    }

    if (!roomFeaturesCollectionId) {
        throw new Error("WEBFLOW_ROOM_FEATURES_COLLECTION_ID is not configured.");
    }

    if (!token) {
        throw new Error("WEBFLOW_API_TOKEN is not configured.");
    }

    const [roomItems, roomFeatureItems] = await Promise.all([
        fetchWebflowCollection<WebflowRoomItem>(roomsCollectionId, token),
        fetchWebflowCollection<WebflowRoomFeatureItem>(roomFeaturesCollectionId, token),
    ]);

    const roomFeaturesById = buildRoomFeaturesById(roomFeatureItems);

    return roomItems
        .map(normalizeCmsRoom)
        .filter((room): room is NormalizedCmsRoom => room !== null)
        .map((room) => ({
            ...room,
            roomFeatures: room.roomFeatureIds
                .map((featureId) => roomFeaturesById.get(featureId))
                .filter((feature): feature is RoomFeature => feature !== undefined),
        }));
}


function mergeRoomsForProduct(params: {
    productCode: string;
    roomCategory: RoomCategory;
    priceOptions: RezdyPriceOption[];
    cmsRoomsByKey: Map<string, NormalizedCmsRoom>;
}) {
    const {productCode, roomCategory, priceOptions, cmsRoomsByKey} = params;

    return priceOptions
        .filter((priceOption) => typeof priceOption.label === "string")
        .map((priceOption) => {
            const label = String(priceOption.label);
            const optionProductCode = getPriceOptionProductCode(priceOption, productCode);
            const cmsMatchKey = getCmsRoomMatchKey(optionProductCode, label);
            const cms = cmsRoomsByKey.get(cmsMatchKey) ?? null;
            const publicCms = cms
                ? (({roomFeatureIds, ...rest}) => rest)(cms)
                : null;

            return {
                roomCategory: cms?.roomCategory ?? roomCategory,
                productCode: optionProductCode,
                priceOption: {
                    id: priceOption.id,
                    label: priceOption.label,
                    price: priceOption.price,
                    seatsUsed: priceOption.seatsUsed,
                    productCode: optionProductCode,
                },
                cms: publicCms,
                warnings: cms
                    ? []
                    : [
                        `No matching Webflow room CMS item found for ${optionProductCode} / ${label}.`,
                    ],
            };
        });
}

/**
 * GET /api/rooms
 * Query params:
 *   superiorProductCode * — Rezdy product code for Superior room options
 *   premiumProductCode * — Rezdy product code for Premium room options
 * Combines Rezdy priceOptions with Webflow room CMS information.
 */
rooms.get("/", async (c) => {
    const {superiorProductCode, premiumProductCode} = c.req.query();

    const missing: string[] = [];
    if (!superiorProductCode) missing.push("superiorProductCode");
    if (!premiumProductCode) missing.push("premiumProductCode");

    if (missing.length) {
        return c.json(
            {error: `Missing required params: ${missing.join(", ")}.`},
            400
        );
    }

    if (
        !productCodeFmt.test(superiorProductCode) ||
        !productCodeFmt.test(premiumProductCode)
    ) {
        return c.json({error: "Invalid product code format."}, 400);
    }

    if (superiorProductCode === premiumProductCode) {
        return c.json(
            {
                error:
                    "superiorProductCode and premiumProductCode must be different product codes.",
            },
            400
        );
    }

    try {
        const client = new RezdyClient(c.env);

        const [superiorData, premiumData, cmsRooms] = await Promise.all([
            client.get<RezdyProductResponse>(`/products/${superiorProductCode}`),
            client.get<RezdyProductResponse>(`/products/${premiumProductCode}`),
            fetchWebflowRooms(c.env),
        ]);

        const superiorProduct = getProductFromResponse(superiorData);
        const premiumProduct = getProductFromResponse(premiumData);

        const cmsRoomsByKey = new Map(
            cmsRooms.map((cmsRoom) => [
                getCmsRoomMatchKey(cmsRoom.productCode, cmsRoom.roomLabel),
                cmsRoom,
            ])
        );

        const superiorRooms = mergeRoomsForProduct({
            productCode: superiorProductCode,
            roomCategory: "superior",
            priceOptions: getPriceOptions(superiorProduct),
            cmsRoomsByKey,
        });

        const premiumRooms = mergeRoomsForProduct({
            productCode: premiumProductCode,
            roomCategory: "premium",
            priceOptions: getPriceOptions(premiumProduct),
            cmsRoomsByKey,
        });

        const allRooms = [...superiorRooms, ...premiumRooms];

        return c.json({
            products: {
                superior: {
                    productCode: superiorProductCode,
                },
                premium: {
                    productCode: premiumProductCode,
                },
            },
            rooms: allRooms,
            grouped: {
                superior: superiorRooms,
                premium: premiumRooms,
            },
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch Rezdy room products.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        if (err instanceof Error) {
            return c.json(
                {error: "Failed to fetch room data.", detail: err.message},
                502
            );
        }

        throw err;
    }
});

export default rooms;