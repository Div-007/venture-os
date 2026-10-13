/** The sample-data prototype at /demo is a development aid; production builds hide it unless NEXT_PUBLIC_ENABLE_DEMO=true. */
export const demoEnabled = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENABLE_DEMO === "true";
