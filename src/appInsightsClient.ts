"use strict";

// fork: 原有实现会把运行事件上报到上游作者的 Application Insights，这里改为空实现。
export class AppInsightsClient {
    public sendEvent(name: string, properties?: any): void {
        // no-op
    }
}
