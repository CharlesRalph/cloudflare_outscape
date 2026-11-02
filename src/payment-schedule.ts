import type {PaymentSchedule} from "./types";

const BALANCE_DUE_DAYS_BEFORE_DEPARTURE = 30;
const DEPOSIT_AMOUNT_DOLLARS_PER_GUEST = 1000;

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function formatDateOnly(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

export function parseRezdyLocalDateTime(value: string): Date | null {
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
    );

    if (!match) return null;

    const [, year, month, day, hour, minute, second] = match;

    const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
    );

    return Number.isNaN(date.getTime()) ? null : date;
}

export function getPaymentSchedule(params: {
    totalAmount: number;
    departureDate: Date;
    guestCount: number;
    now?: Date;
}): PaymentSchedule {
    const now = params.now ?? new Date();

    const balanceDueDate = addDays(
        params.departureDate,
        -BALANCE_DUE_DAYS_BEFORE_DEPARTURE
    );

    const depositAvailable = startOfDay(now) < startOfDay(balanceDueDate);

    const depositAmount = depositAvailable
        ? roundMoney(Math.min(DEPOSIT_AMOUNT_DOLLARS_PER_GUEST * params.guestCount, params.totalAmount))
        : 0;

    const balanceAmount = depositAvailable
        ? roundMoney(Math.max(params.totalAmount - depositAmount, 0))
        : 0;

    return {
        depositAvailable,
        requiredPaymentType: depositAvailable ? "deposit_or_full" : "full",
        depositAmount,
        balanceAmount,
        balanceDueDate: formatDateOnly(balanceDueDate),
        balanceDueDaysBeforeDeparture: BALANCE_DUE_DAYS_BEFORE_DEPARTURE,
    };
}