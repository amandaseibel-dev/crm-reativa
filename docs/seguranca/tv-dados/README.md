# tv-dados — fechamento do acesso anônimo aos indicadores da TV

## O problema (confirmado 04/11/2026 08:30)

A Edge Function `tv-dados` (criada 02/11/2026, `verify_jwt: false`, só em produção,
sem arquivo no repositório) respondia a qualquer `GET` anônimo com honorários do
dia e do mês, projeção, recuperado, pagamentos e o top-3 de operadores. Lia o
`tv_snapshot` com a `SUPABASE_SERVICE_ROLE_KEY`, pulando o allowlist
`public.tv_pode_ler_snapshot()`. A restrição de CORS a `reativa-tv.netlify.app`
não impede leitura direta (navegador, curl).

Dependências reais (logs `function_edge_logs`, 02–04/11): 3 chamadas, todas de
teste de sessão, sem `origin`/`referer`. A TV publicada (carrossel React) lê o
snapshot via `supabase.rpc('tv_snapshot_ler')` com a sessão do usuário — **não
usa** `tv-dados`. O único consumidor desenhado é o pacote estático aprovado
(`config.json` de `~/Downloads/tv-reativa-v11-deploy`), ainda não publicado.

## A correção (v2, `supabase/functions/tv-dados/index.ts`)

Três portões independentes:

1. **Gateway** — `verify_jwt: true`: sem JWT válido a requisição não chega à função.
2. **Identidade** — `supabase.auth.getUser()` com o `Authorization` do chamador tem
   de devolver um usuário com e-mail. A anon key e a service role key passam no
   gateway, mas não têm usuário → `401`.
3. **Autorização** — `public.tv_pode_ler_snapshot()` (allowlist:
   `painel.tv@reativa.local`, `amanda.seibel@aelbra.com.br`,
   `cobranca04@aelbra.com.br`) → fora do allowlist `403`. Em seguida
   `tv_snapshot_ler()` roda **como o próprio usuário** (a função já repete a
   mesma checagem internamente). A service role não é mais usada.

Mapeamento de campos idêntico à v1, com um acréscimo: `resultado.projecao_parcial`
(boolean), vindo de `mes.projecao_parcial` do snapshot.

## Provas

Regra de autorização no banco (claims simuladas em transação, nada gravado):

| caso | `tv_pode_ler_snapshot()` |
|---|---|
| `role = anon` | `42501 permission denied` (não executa) |
| autenticado, e-mail fora do allowlist | `false` |
| autenticado, `amanda.seibel@aelbra.com.br` | `true` |

Testes de ponta a ponta na função publicada: ver "Estado".

## Reversão segura (sem reabrir o acesso público)

Voltar à v1 **não é** reversão aceitável: ela é o próprio vazamento
(`index.v1-publica-NAO-REIMPLANTAR.ts.txt` fica aqui só para auditoria).
Se a v2 falhar:

- **Opção A (recomendada):** remover a função — nenhum sistema em produção a
  consome; a TV publicada e o CRM seguem lendo pelo RPC autenticado.
- **Opção B:** reimplantar a v2 (`supabase functions deploy tv-dados
  --project-ref ahattpqrjmhkzsmnbdzs`; `verify_jwt` padrão = true).

Nada aqui toca `tv_snapshot`, `tv_snapshot_atualizar`, o cron 85, outras
funções ou dados financeiros.

## Estado (04/11/2026, 09:14–09:33 local)

- [x] v2 publicada em produção pelo Dashboard (sessão da gestão), com autorização
      específica: `version: 2`, `updated_at` 12:14:10 UTC, sha256 `77c10c9f…`,
      `verify_jwt: true` (conferido pela API de gestão). O MCP
      `deploy_edge_function` está em `permissions.deny` do projeto e foi mantido.
- [x] teste 1 — sem `Authorization`: `401 UNAUTHORIZED_NO_AUTH_HEADER` (gateway);
      nenhum dado devolvido
- [x] teste 2 — só a publishable key (`apikey`), sem usuário: `401
      {"error":"autenticacao obrigatoria"}` (função); nenhum dado devolvido
- [x] teste 3 — usuário autenticado fora do allowlist: no banco, o RPC que a v2
      chama como o usuário (`tv_snapshot_ler`) devolve `42501 Acesso negado`; e
      `tv_pode_ler_snapshot()` → `false`. Ponta a ponta não executado: não existe
      sessão de usuário fora do allowlist disponível, e credenciais não foram
      criadas para o teste.
- [ ] teste 4 — usuário do allowlist, ponta a ponta: **não executado**. A sessão
      autorizada existe na aba da TV, mas a extensão do navegador bloqueia a
      leitura do token por script (proteção correta). No banco:
      `tv_pode_ler_snapshot()` → `true` para `amanda.seibel@aelbra.com.br`.
      Ponto de atenção: o "Verify JWT with legacy secret" só aceita tokens
      assinados pela chave legada; se o projeto migrar para chaves novas, a
      sessão de usuário será barrada no gateway (401) e o toggle terá de ser
      revisto — a v2 continua negando anônimos por conta própria.
- [x] TV publicada (carrossel, RPC autenticado), CRM (`projecao_snapshot`
      12:09), `tv_snapshot` v776 (cron 12:00) e cron 85 ativo com rodadas
      `succeeded` 11:45 e 12:00 — nada afetado.

**Exposição pública encerrada** a partir de 12:14 UTC de 04/11/2026.

## v2.1 — fila do Receptivo (mesma proteção)

`index.ts` neste repositório já traz a v2.1: acrescenta `receptivo.proximos`
(até 4 nomes), `receptivo.online` e `receptivo.atualizado_em`, lidos **como o
usuário** de `usuarios` (`receptivo = true`) e `fila_receptivo`, com a mesma
regra da tela FilaReceptivo do CRM (sem pausa, heartbeat ≤ 90 s, ordem por
`atendimentos_hoje` → `ultimo_atendimento` → `online_em`). Nenhum valor
financeiro individual; qualquer falha devolve a fila vazia. Os três portões da v2
não mudam. Publicação pelo Dashboard (Code → Deploy updates), com Verify JWT
mantido ligado.

## v3 (10/11/2026) — destaques por operador, meta e centavos

- Lê `public.tv_painel_operadores()` (migration **pendente**
  `supabase/aguardando_aprovacao/20261110200000_tv_painel_operadores.sql.pendente`),
  como o próprio usuário. Mesmo portão do snapshot (`tv_pode_ler_snapshot`).
- Fotos: pela Edge Function oficial `foto-perfil-url`, com o JWT do usuário da
  TV (URL assinada de 5 min). Nenhuma permissão nova; o id do operador não sai
  para o navegador.
- O pódio de reconhecimento (destaques do mês) sai só com nome/foto, sem valor.
  Os cards de ranking levam o resultado. Pacote e mapa de valores:
  `PACOTE-M1-20261110200000.md`.
- Sem a função no banco, a v3 responde como a v2 + `meta_honorarios_mes` e dias
  úteis do snapshot, pódio/acordos de hoje do snapshot (`precisao: 'inteiro'`)
  e os rankings que o snapshot não tem como `null` ("dado indisponível").
- Publicar: `supabase functions deploy tv-dados --project-ref ahattpqrjmhkzsmnbdzs`
  (verify_jwt padrão = true). Reversão: reimplantar a v2 do commit anterior.
