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
| Curso, campus, turno, situação acadêmica | 🟢 VERDE | Sim | `student_composite`/`contracts` | Sim | nenhum |
| Contrato vigente | 🟢 VERDE | Sim | `contracts[]` | Sim | nenhum |
| Filiação a portador (166/195) | 🟢 VERDE | Sim | `students_search?carrierId=` | Sim | nenhum |
| Existência de título original (mensalidade) | 🟢 VERDE | Sim | `financial_statement` | Sim | nenhum |
| Boleto (7 díg.) ↔ `acordos_titulos.documento` | 🟢 VERDE | Sim | `financial_statement[].boleto` | Sim | nenhum |
| Decomposição de valor (principal/multa/juros/honorário) | 🟢 VERDE | Sim | `financial_statement[]` | Sim | nenhum |
| Mensalidade liquidada (portador 195) | 🟡 AMARELO | Parcial | `financial_statement[].paymentDate` | Condicional — só dentro da regra de entrada em prod, nunca `paymentDate` isolado | `paymentDate` não distingue negociado de aberto sozinho |
| Caixa efetivamente recebido | 🟡 AMARELO | Parcial (fonte é o Santander, não a Prime) | fora da API | Sim, mas fora desta integração | `paidAmount` da Prime é dívida corrigida, não caixa |
| **Estrutura financeira do acordo** (parcelas, valor negociado, vencimentos) | 🔴 VERMELHO | **Visível na tela do Prime; rota estruturada NÃO identificada** | `/agreements` responde vazio (48 rotas candidatas testadas, todas 404 exceto essa) | **NÃO** | Comprovadamente não exposta pela superfície pública testada — não é "não existe". Ver Premissa 19/20 |
| Quem fechou o acordo | 🔴 VERMELHO | Não | sondado por `prime-acordo`, nada encontrado | Não | mesma superfície do gap acima |
| Quais mensalidades o acordo substituiu | 🔴 VERMELHO | Não, na API. Reconstrução interna existe (teto ALTA_CONFIANÇA) | — | Condicional, com revisão humana — nunca `CONFIRMADO` | idem |
| Status do acordo (confirmado/quebrado/renegociado/cancelado) | 🔴 VERMELHO | Não | — | Não | idem |
| Total de parcelas quando o acordo não está quitado | 🔴 VERMELHO | Não (só vemos as pagas, via extrato) | — | Não | idem |
| OpenAPI/Swagger da Prime | 🔴 VERMELHO | Não — 404 em produção | `/swagger`, `/openapi.json`, `/docs` | — | pedir à TI da ULBRA, decisão de contato externo não tomada até 15/09/2026 |
| RPC/tabelas de produção sem migration | 🔴 VERMELHO (drift, não é gap de dado) | Existem em produção, não no repositório | `prime_chave_api()`, `prime_extrato`, `prime_extrato_fila` | — | reconciliar com migration — não aplicado nesta etapa (leitura/mapeamento só) |
| Rotina que alimenta `prime_extrato_fila` | 🔴 VERMELHO (processo, não é gap de dado) | Não localizada em `src/` nem Edge Functions do repo | — | — | provável SQL/cron só em produção; investigar antes de depender |

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

## A resposta à prioridade imediata

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

---

## Granularidade do portador: CPF, não título (2026-09-24)

| informação | status | por quê |
|---|---|---|
| aluno/CPF está no portador N | **VERDE** | `students_search?carrierId=N`, snapshot por ciclo com remoção de quem saiu |
| **título X está em condição jurídica** | **VERMELHO** | a fonte não tem essa granularidade — ver `prime-mapa-identificadores.md`, "RESTRIÇÃO DE ARQUITETURA" |

Impacto direto: a reversão de títulos `CANCELADA` por causa judicial (262
títulos, 60 CPFs, R$ 2.399.695,89) não pode ser decidida só pela saída do CPF
do portador 202.

## 195 e 202 não são exclusivos (2026-09-24)

| afirmação | vale? |
|---|---|
| CPF está no 195 | VERDE — snapshot por ciclo |
| CPF está no 202 (jurídico) | VERDE — desde 24/09/2026 |
| **CPF está no 195, logo saiu do jurídico** | **FALSO** — 37 dos 72 CPFs do 202 estão também no 195 |

A ausência do jurídico só é afirmável por `prime_aluno_no_juridico(cpf) = 'NAO'`,
que exige snapshot 202 completo e válido.
