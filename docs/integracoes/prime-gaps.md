# Gaps — Prime/ULBRA

Classificação: **VERDE** (acessível e suficientemente mapeado) · **AMARELO**
(disponível parcialmente ou com limitação) · **VERMELHO** (fonte ainda não
localizada). Ver [README.md](README.md) para o índice.

Regra de escrita usada nesta tabela: nunca "não existe" — sempre "não
encontrada nos caminhos já mapeados" (AMARELO/em investigação) ou
"comprovadamente não disponibilizada pela API pública, dado visível só por
outra via" (VERMELHO com evidência). Ver a formulação completa em
`docs/PREMISSAS.md`, Premissa 19.

| Informação necessária | Status | Fonte encontrada? | Endpoint | Automatizável? | Gap |
|---|---|---|---|---|---|
| Cadastro (telefone, e-mail, endereço) | 🟢 VERDE | Sim | `student_composite` | Sim | nenhum |
| CPF confiável | 🟢 VERDE | Sim | `student_composite` | Sim | nenhum |
| Curso, campus, turno | 🟢 VERDE | Sim | `students_search`/`contracts` | Sim | nenhum |
| Situação acadêmica, por vínculo de curso | 🟡 AMARELO | Sim, em `students_search` → `items[].status` | `students_search` | Parcial | **status nulo em 14 de 35 vínculos** na amostra de 6 alunos (28/09/2026); **sem identificador estável do vínculo nos endpoints consultados**, e a chave composta não o separa — 21 de 35 linhas casam com mais de um contrato e 3 vínculos do mesmo aluno compartilham curso+campus+turno com status diferentes |
| Situação acadêmica da PESSOA (um rótulo só) | 🔴 VERMELHO | Não | — | Não | a fonte só expressa por vínculo de curso; um rótulo por pessoa não existe na API e não pode ser derivado sem escolher arbitrariamente entre vínculos que discordam |
| Contrato vigente | 🟢 VERDE | Sim | `contracts[]` | Sim | nenhum |
| Filiação a portador (166/195) | 🟢 VERDE | Sim | `students_search?carrierId=` | Sim | nenhum |
| Título a vencer e atraso inicial (0–31 dias) — existência, vencimento, valor | 🟢 VERDE | Sim | `financial_statement`, `carrier.id = 95` | Sim | nenhum — medido 28/09/2026: 19.795 a vencer, 7.182 em 1–31 dias |
| **Situação do título (pago/aberto/cancelado) e saldo em aberto** | 🔴 VERMELHO | Não | — | **Não** | **Medido ao vivo 28/09/2026: `financialStatement` tem 13 campos e nenhum é situação, status ou saldo.** `paymentDate` preenchido em 100% das linhas (0 de 302.477 nulos no portador 95), inclusive em título a vencer; `paidAmount` é valor de tabela. Sem isso, "quem pagou" não é respondível pela API — só redução de saldo entre consultas, que não é recebimento |
| **Evento de pagamento (data + valor) da mensalidade corrente** | 🔴 VERMELHO | Não | — | **Não** | Provado com variável independente em 28/09/2026: entre 101 títulos que o relatório de inadimplência do dia dá como EM ABERTO, 101 têm `paymentDate` e 61 têm `paidAmount = netAmount`. Também verificado que nenhuma outra integração autorizada cobre isso (`public.pagamentos` guarda número de ACORDO de 5 dígitos, não boleto). O pedido técnico exato está em `docs/preventivo/README.md`, seção 4 |
| Existência de título original (mensalidade) | 🟢 VERDE | Sim | `financial_statement` | Sim | nenhum |
| Boleto (7 díg.) ↔ `acordos_titulos.documento` | 🟢 VERDE | Sim | `financial_statement[].boleto` | Sim | nenhum |
| **Parcela do acordo a partir dos 4 últimos dígitos do boleto** | 🟡 AMARELO | A semântica dos 4 dígitos **não foi determinada** nas amostras e medições já feitas | — (estrutura do próprio título) | **NÃO** — e não deve ser tentado | **Medido em 23/10/2026 sobre 14.488 parcelas:** nenhuma convenção fixa explica mais de **56,3%**; `= parcelas.numero` só 51,5%; **11,5% não casam com nenhuma** das quatro leituras testadas. Causas medidas: 946 de 4.831 acordos numeram parcelas a partir de 0 e 863 têm parcela sem boleto. **A via correta existe e é confiável:** casar o boleto inteiro com `parcelas.boleto`. Ver [`prime-mapa-identificadores.md`](prime-mapa-identificadores.md) |
| Número do acordo nos 6 dígitos centrais do boleto | 🟢 VERDE | Sim | `parcelas.boleto` / `documentNumber` | Sim | **51 parcelas em 47 acordos divergem** de `acordos.numero_ulbra` (13.703 de 13.754 comparáveis conferem, 99,6%; outras 734 têm `numero_ulbra` nulo e ficam fora da comparação). Divergência não investigada caso a caso — medida em 23/10/2026 |
| Decomposição de valor (principal/multa/juros/honorário) | 🟢 VERDE | Sim | `financial_statement[]` | Sim | nenhum |
| Mensalidade liquidada (portador 195) | 🟡 AMARELO | Parcial | `financial_statement[].paymentDate` | Condicional — só dentro da regra de entrada em prod, nunca `paymentDate` isolado | `paymentDate` não distingue negociado de aberto sozinho |
| Caixa efetivamente recebido | 🟡 AMARELO | Parcial (fonte é o Santander, não a Prime) | fora da API | Sim, mas fora desta integração | `paidAmount` da Prime é dívida corrigida, não caixa |
| **Estrutura financeira do acordo** (parcelas, valor negociado, vencimentos) | 🔴 VERMELHO | **Visível na tela do Prime; rota estruturada NÃO identificada** | `/agreements` responde vazio (48 rotas candidatas testadas, todas 404 exceto essa) | **NÃO** | Comprovadamente não exposta pela superfície pública testada — não é "não existe". Ver Premissa 19/20 |
| Quem fechou o acordo | 🔴 VERMELHO | Não | sondado por `prime-acordo`, nada encontrado | Não | mesma superfície do gap acima |
| Quais mensalidades o acordo substituiu | 🔴 VERMELHO | Não, na API. Reconstrução interna existe (teto ALTA_CONFIANÇA) | — | Condicional, com revisão humana — nunca `CONFIRMADO` | idem |
| Status do acordo (confirmado/quebrado/renegociado/cancelado) | 🔴 VERMELHO | Não | — | Não | idem |
| Total de parcelas quando o acordo não está quitado | 🔴 VERMELHO | Não (só vemos as pagas, via extrato) | — | Não | idem |
| OpenAPI/Swagger da Prime | 🔴 VERMELHO | Não — 404 em produção | `/swagger`, `/openapi.json`, `/docs` | — | pedir à TI da ULBRA, decisão de contato externo não tomada até 15/09/2026 |
| RPC/tabelas de produção sem migration | 🟡 AMARELO (drift, não é gap de dado) | **Censo completo em 20/10/2026: 8 tabelas e 27 funções `prime*` sem migration.** O subsistema `prime_extrato` (2 tabelas + 5 funções) foi versionado — ver `20261020122217_versionar_subsistema_prime_extrato.sql` | `prime_chave_api()`, `prime_extrato`, `prime_extrato_fila`, `prime_extrato_reenfileirar()`, `prime_extrato_mutirao()`, `prime_extrato_ok()`, `prime_extrato_falhou()` | — | **Restam 28 objetos**: piloto acadêmico (2 tabelas + 11 funções), portador 202 (4 funções), `prime_alunos_sync`, `prime_mensalidades_sync`, `prime_sync_cursor`, `prime_sync_execucoes`, e 8 funções avulsas. Outro subsistema, PR própria |
| Rotina que alimenta `prime_extrato_fila` | 🟢 VERDE | **LOCALIZADA em 20/10/2026**: `public.prime_extrato_reenfileirar()`, agendada no pg_cron como `prime_extrato_reenfileirar_semanal` (`5 2 * * 6`). Não estava em `src/` nem nas Edge Functions porque é função SQL agendada — e também não tinha migration | `prime_extrato_reenfileirar()` | Sim | nenhum — versionada em `20261020122217`. A fila é drenada por `prime_extrato_mutirao()` (job 35, `*/2 2-23 * * 6`), que faz `net.http_post` para a Edge Function `prime-extrato` |

## Drift de banco encontrado (não é gap de API — é gap de reprodutibilidade)

Confirmado por leitura direta do schema de produção (`information_schema`) e
`pg_proc`, comparado contra `grep` no repositório:

- **`public.prime_chave_api()`** — função existe em produção
  (`SECURITY DEFINER`, só `service_role`, lê `vault.decrypted_secrets` /
  `prime_api_key`) e **não tem migration correspondente no repositório**.
  É funcionalmente idêntica a `public.prime_api_key_backend()`, que **está**
  versionada (`20260825008000_prime_cadastro_correcoes_do_primeiro_disparo.sql`)
  — duas RPCs fazendo a mesma coisa, uma delas invisível ao `git log`.
- **`public.prime_extrato`** e **`public.prime_extrato_fila`** — tabelas
  existem em produção (colunas confirmadas por `information_schema.columns`),
  usadas pela Edge Function `prime-extrato` (agora versionada em
  `supabase/functions/prime-extrato/`), mas **nenhuma migration do
  repositório contém o `CREATE TABLE`** de nenhuma das duas.
- **`public.prime_mensalidades_sync`** — tabela órfã: existe em produção
  (colunas incluem `is_agreement`, exatamente o campo que se esperava usar
  para achar parcela de acordo), está **vazia**, e tem **zero ocorrências**
  em todo o repositório (nem migration, nem código, nem menção em Edge
  Function). A sincronização que a alimentaria nunca rodou — provavelmente
  substituída por `prime_extrato` sem que a tabela antiga fosse removida.

**Não corrigido nesta etapa** — é mapeamento, não é a hora de aplicar
migration em produção. Registrado como item de prioridade alta no backlog
técnico (ver `docs/BACKLOG-TECNICO.md`).

## Origem do relatório de pagamentos do convênio 0272047 (portador 166)

**Pergunta da gestão, 2026-10-20:** qual é a origem técnica do relatório de
pagamentos do portador 166 (SANTANDER REATIVA, convênio 0272047) que a gestão
exporta e importa na Projeção?

**O que o CRM já sabe do arquivo.** O leitor é `normalizarLinhaSantander`, em
`src/pages/ProjecaoHoraHora.jsx`. Não há cabeçalho de verdade; as colunas são
fixas por posição: A instituição · B `matrícula - nome do aluno` · C título
(número do acordo) · D operador (`NOME.SOBRENOME`) · E código convênio+título
(`5`+acordo(6)+parcela(4)) · F convênio · G vencimento · H valor original ·
I honorário · J data de pagamento · K valor pago.

**O que essas colunas dizem sobre a origem.** Quatro delas não podem vir de um
retorno bancário: `instituição`, `matrícula + nome do aluno`, `honorário` e,
sobretudo, `operador` no formato de login da operação — banco não conhece o
operador que fechou o acordo nem o honorário da assessoria. A origem é,
portanto, um **relatório do lado ULBRA/Prime** sobre os recebimentos do convênio
0272047, não um arquivo de retorno do Santander. A linha "matrícula do arquivo
Santander" de [`prime-mapa-identificadores.md`](prime-mapa-identificadores.md)
descreve o CONTEÚDO do arquivo, não a sua origem.

**Existe equivalente na API? NÃO, na superfície testada — e isso já estava
medido.** O catálogo tem seis recursos de leitura e nenhum de relatório ou
recebimento. Em 2026-09-15 foram testados 48 caminhos candidatos (`/agreements`,
`/negotiations`, `/installments`, `/titles`, `/documents`, `/billings`,
`/renegotiations`, `/payment-plans`, `/carriers/{id}/titles`, variantes com
`?registration=`, `?includeInstallments=`, `?expand=`, `?detail=full`, prefixos
`/v1` e `/v2`): **todos 404, sem um único 405** — e 405 é o que indicaria rota
existente com outro verbo. `swagger`, `openapi` e `docs` também 404. A única
superfície do 166 que responde é a **filiação** (`/students?carrierId=166`,
26.825 alunos), que não tem dimensão financeira nenhuma.

**O limite da integração, escrito do jeito certo:** o recebimento do convênio
0272047 **não foi exposto pela superfície de integração testada com a X-API-Key
atual**. O dado chega à ReATIVA todos os dias — pelo arquivo, não pela API. E o
arquivo já é importado: ele vira `pagamentos`, com `titulo_numero` (acordo) e
`numero_parcela_completo` (`5`+acordo+parcela, padrão verificado em 9.086
pagamentos sem exceção).

## A resposta à prioridade imediata

> **Reconferido em 2026-10-20, e o resultado não mudou.** Os quatro testes
> do portador 166 foram rodados na matrícula `232005643` (aluno filiado ao
> 166, acordo 5629 **ATIVO** no CRM, 12 parcelas) pela tela
> `/diagnostico-prime` — com a sessão da própria gestão, sem ninguém
> manusear token: (1) `financial-statement` → 48 títulos, **zero do 166**;
> (2) `financial-statement?carrierId=166` → **resposta idêntica**, comparada
> corpo inteiro em JSON canônico; (3) `agreements` → **zero itens**;
> (4) composto `/students/232005643` → campo `agreements` **vazio**.
> Não repetir estes quatro testes nem varrer alunos: a pergunta está
> respondida por três populações independentes (09/09, 15/09 e 20/10).

**Onde está a estrutura financeira dos acordos: NÃO foi localizada por
nenhuma rota da API Prime/ULBRA testada até hoje**, e a superfície foi
varrida de forma sistemática o suficiente para que essa conclusão não seja
"ainda não achei" — é "testei o que existia para testar, com sweep de
parâmetros e populações independentes, e a resposta é sempre vazia,
**inclusive para um acordo confirmado como ATIVO na tela do Prime no mesmo
instante da chamada**". Isso é o que torna VERMELHO uma classificação com
evidência, não uma ausência de busca.

**O dado, porém, existe** — está comprovadamente visível na interface web do
Prime (tela de detalhe do acordo, conferida caractere a caractere no acordo
71903 em 15/09/2026: sete títulos originais, composição em quatorze linhas,
dez parcelas novas, todas nomeadas e não apenas inferidas). O que falta
identificar é **a URL/rota que essa tela consome** — não é a existência do
dado que está em aberto, é a superfície estruturada.

**O único caminho conhecido para destravar isso:** capturar, via F12 → Rede,
a requisição que a própria interface do Prime faz ao abrir a tela de detalhe
de um acordo. Ninguém fez esse contato/captura ainda; abrir essa frente
(inclusive decidir se cabe contato formal com a TI da ULBRA) é decisão da
gestão, não tomada até a data desta auditoria.

Detalhe completo, com a evidência medida título a título: `docs/PREMISSAS.md`,
Premissas 19 e 20.

---

# Rastreamento de proveniência — 2026-09-22

Rodada específica de **proveniência**, pedida pela gestão com duas restrições
explícitas: **não** continuar tentando nomes de endpoint por força bruta, e
**não** transferir para a gestão a tarefa de capturar a URL por F12. A pergunta
era: *de onde vem originalmente a estrutura financeira de um acordo Prime?*

Caso de rastreamento: **acordo 71643**.

## O que o censo de produção mostra — e é evidência nova

Até aqui, a afirmação "a API responde vazio" vinha de sondagens pontuais. Ela
agora tem um **censo**, porque `prime-portador` grava o resultado de cada
tentativa oficial:

| Evidência | Medida | O que significa |
|---|---|---|
| `auditoria` com `acao='ACORDO_ENCONTRADO_NA_API'` | **0 linhas** | `/students/{reg}/agreements` **nunca** devolveu lista preenchida em produção. A função existe para gravar o payload cru no instante em que isso acontecer; nunca disparou |
| `prime_extrato` | 399.506 linhas, portador 166 = **0** | coleta independente nº 1 |
| `prime_titulo_semestre` | 400.325 linhas, portador 166 = **0** | coleta independente nº 2 — não estava registrada aqui antes |
| `prime_portador_membro` | filiação ao 166 existe | o **vínculo** ao portador de acordo é visível; a **estrutura** não |

Três coletas independentes, ~800 mil linhas de título, e o portador 166 não
aparece em nenhuma linha de título de nenhuma delas.

## ⚠️ Defeito de instrumentação encontrado

`fila_pagamento_sem_vinculo.consulta_estrutura_resultado` — a coluna desenhada
justamente para distinguir *"perguntei e a API disse que não tem"* de *"nunca
perguntei"* — está **NULL em 182 de 182 linhas**.

O recorder (`conciliacao_registrar_consulta_estrutura`) existe, e
`prime-portador` o chama nos três desfechos. Mas **nenhum resultado foi gravado
até hoje**: ou o modo pontual nunca foi invocado com `pagamento_id`, ou a
gravação falha em silêncio.

Consequência prática: a cadeia de decisão descrita na Premissa 19/20 —
`NAO_ENCONTRADA` abre o fallback, `ENCONTRADA`/`ERRO`/`NULL` nunca abrem — hoje
opera **sempre no ramo NULL**. Nada quebra por isso (NULL é o lado seguro), mas
a evidência que ela deveria produzir não existe. **Não corrigido aqui** —
é achado de arquitetura, e mexer nisso toca o motor de conciliação, que estava
fora do escopo desta rodada.

### Remedida em 2026-10-21, e a causa apareceu

A tabela cresceu de 182 para **655 linhas** (386 sem decisão da gestão) e
`consulta_estrutura_resultado` segue **NULL em 655 de 655**. Duas medições novas
explicam por quê:

| medida | valor |
|---|---|
| `consulta_portador_em` nos 296 pagamentos `AGUARDANDO_ACORDO` que esperam a consulta | **NULL em 296 de 296** |
| `auditoria` com `acao='ACORDO_ENCONTRADO_NA_API'` | **0 linhas** |
| etapa `consulta_portador` em `fluxo_pagamentos_config` | **`ligado = false`** |
| `fluxo_pagamentos_rodar` chama `conciliacao_reprocessar` (único caminho até a consulta)? | **não** |

**A consulta nunca rodou uma única vez** — não é que a API tenha respondido
"não tem". Os dois leitores de `consulta_portador`
(`conciliacao_reprocessar`, `conciliacao_consultar_portador_pendentes`) nunca
foram alcançados pela rodada horária, porque `fluxo_pagamentos_rodar` não os
chama; e a própria etapa está desligada.

Portanto o ramo NULL não é falha de gravação: é ausência de chamada. O defeito
de instrumentação acima permanece válido, mas a causa raiz é de **fiação**, não
de recorder.

Consequência para quem for religar a automação: **não presuma que a consulta
resolveria os 296**. O que falta neles é a estrutura do acordo, classificada
🔴 VERMELHO nesta mesma página (`/agreements` responde vazio, 48 rotas
candidatas testadas). Medido no mesmo dia: dos 296, **zero são à vista**, então
`recuperar_acordo_avista` também não os alcança. Eles dependem de o acordo
entrar no CRM — importação do relatório ou registro da gestão — não de uma
consulta à API.

Também medido: `quantidade_tentativas` chega a **241** numa linha, com média
**54,1**, e **386 de 386** linhas sem decisão foram tentadas nas últimas 24h
mesmo com o cron horário desligado desde 24/09 — a rota de importação também
aciona o motor. Reavaliar casos sem saída a cada rodada é o que empurra
pagamento novo para o fim da fila.

## Fontes de payload histórico: todas fechadas

Procurei payload guardado de resposta da Prime, em qualquer lugar do ambiente:

| Onde | Resultado |
|---|---|
| `net._http_response` (respostas do pg_net) | **0 linhas** — o TTL do pg_net poda; não há histórico de chamada HTTP |
| `net.http_request_queue` | 0 pendentes |
| `prime_alunos_sync` — **tem coluna `raw`**, que guardaria o payload por aluno | **0 linhas**. Segunda tabela órfã, além de `prime_mensalidades_sync` |
| `prime_mensalidades_sync` (coluna `is_agreement`) | 0 linhas, já registrado acima |
| `_fase2a_sonda_prime` | 6 linhas, de 12/09, só `financial-statement` de liquidação — nenhuma tentativa a `agreements` |
| `importacoes_acordos` | 134 linhas, e **só contadores** (`parcelas`, `acordos`, `cpfs`, `total`). O conteúdo bruto do relatório importado **não é retido em lugar nenhum** |

Isso encerra a hipótese "o dado já passou por aqui e ficou guardado": não
ficou. O relatório é lido, vira `acordos`/`parcelas`/`acordos_titulos`, e o
arquivo original não é preservado.

## Call graph completo — uma única base URL

Levantado sobre as 17 Edge Functions ativas e todo o `src/`:

- **Base URL:** `https://prime-api.ulbra.ai/api` — **a única**, em 9 funções.
  Nenhum outro host, gateway ou API interna em código, functions, migrations,
  cron ou config.
- **Seis formas de caminho, e só essas:**

| # | Caminho | Usado por |
|---|---|---|
| 1 | `GET /carriers?take=N` | `prime-sync`, `prime-diagnostico` |
| 2 | `GET /students?search={cpf\|nome}&carrierId=&take=` | `prime-cadastro`, `prime-buscar-nome`, `prime-portador`, `prime-diagnostico` |
| 3 | `GET /students?carrierId=N&take=&skip=` | `prime-portador` (varredura) |
| 4 | `GET /students/{registration}` | `prime-acordo`, `prime-extrato`, `prime-titular`, `prime-sync`, `prime-cadastro`, `prime-portador` |
| 5 | `GET /students/{registration}/financial-statement` | `prime-portador` |
| 6 | `GET /students/{registration}/agreements` | `prime-portador` |

`exportar-gestao` foi auditada linha a linha: **100 linhas, nenhuma chamada
externa**. Lê uma tabela do CRM por allowlist (`revisao_prime_aluno`), grava
JSON em bucket privado e devolve URL assinada. Não é fonte de dado Prime.

## Outros hosts: inventariados e descartados

DNS de `prime.ulbra.ai`, `app.ulbra.ai`, `portal.ulbra.ai`, `api.ulbra.ai`,
`web.ulbra.ai`, `prime-web.ulbra.ai`, `cobranca.ulbra.ai` e `ulbra.ai`:
**todos resolvem para o mesmo IP** (`187.60.192.201`, registro coringa) e
**nenhum responde** em HTTPS. `prime-api.ulbra.ai` sem chave devolve
`401 Invalid or missing API key` — o host está vivo e a chave gateia tudo.
Nenhuma documentação pública (`/swagger*`, `/openapi.json`, `/api-docs`,
`/.well-known/openapi`: todos 404 sem autenticação).

## O caso 71643, rastreado ponta a ponta

| Onde aparece | O quê |
|---|---|
| `acordos` | 1 linha — criada pelo CRM |
| `parcelas` | 1 linha, boleto `50716430001` |
| `pagamentos.dados` | 1 linha — o pagamento Santander que originou tudo |
| `auditoria` | 1 linha, `acao = RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO`, por `conciliacao@sistema` |
| Qualquer payload/resposta Prime | **nenhuma ocorrência** |

**A proveniência de 71643 é interna.** O acordo existe no ecossistema ReATIVA
porque o CRM o reconstruiu a partir do pagamento do Santander — não porque
alguma fonte externa o tenha entregue. É exatamente o cenário "pagou antes da
extração", e a recuperação automática do à vista o resolveu.

## Classificação: **D — FONTE AINDA NÃO LOCALIZADA**

Com a ressalva que a Premissa 19 exige: **não é "não existe"**. O dado é
visível na tela do Prime (conferido caractere a caractere no acordo 71903 em
15/09). O que esta rodada acrescenta é que **a busca está esgotada do lado de
cá**:

- ✅ código (`src/`, `supabase/`, `services/`) — varrido
- ✅ 17 Edge Functions — todas lidas, uma única base URL
- ✅ banco — tabelas, colunas JSONB, filas, caches, tabelas órfãs
- ✅ logs de HTTP (`net._http_response`) — vazios por TTL
- ✅ payloads armazenados — nenhum retido
- ✅ URLs/hosts/secrets por nome — inventariados
- ✅ censo de produção da tentativa oficial — 0 respostas preenchidas

**A superfície restante é externa ao nosso ambiente.** Nenhum artefato que
possuímos contém a rota. As duas únicas portas que sobram são a captura na
interface do Prime e o contato formal com a TI da ULBRA — ambas decisão da
gestão, e nenhuma delas é trabalho que este ambiente consiga fazer sozinho.
