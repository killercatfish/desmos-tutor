import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const { app } = buildApp(config);

if (!config.desmosApiKey) app.log.warn('DESMOS_API_KEY is not set; the calculator will not load. See .env.example.');
if (config.providerTrainsOnData) {
  app.log.warn(`LLM endpoint ${config.llm.baseUrl} is treated as a provider that may train on data: demo mode is ON. Fake students only.`);
} else if (!config.llm.isPrivate) {
  app.log.warn(`LLM endpoint ${config.llm.baseUrl} is not on a private network, but PROVIDER_TRAINS_ON_DATA=false. Make sure a data agreement covers it.`);
}

app.listen({ host: config.host, port: config.port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
