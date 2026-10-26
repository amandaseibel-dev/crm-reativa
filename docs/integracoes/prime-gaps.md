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
| Decomposição de valor (principal/multa/juros/honorário) | 🟢 VERDE | Sim | `financial_statement[]` | Sim | nenhum |
| Mensalidade liquidada (portador 195) | 🟡 AMARELO | Parcial | `financial_statement[].paymentDate` | Condicional — só dentro da regra de entrada em prod, nunca `paymentDate` isolado | `paymentDate` não distingue negociado de aberto sozinho |
| **Reversão de liquidação (boleto que volta a aberto na Prime)** | 🔴 VERMELHO | **Não — a API não expressa reabertura** | `financial_statement` não tem campo de situação; `paymentDate` nunca é nulo | **NÃO** | Medido 26/10/2026 no espelho **não filtrado**: **417.072 linhas, 0 com `liquidado_em` nulo**, inclusive **19.315 títulos a vencer**. H1 refutada quanto a `paymentDate`, inconclusiva quanto a campo não mapeado. Ausência de linha é 98,2% reemissão (991 de 1.009), não reversão. Ver a seção dedicada abaixo |
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

# Espelho `prime_extrato`: reversão de liquidação não é observável — 2026-10-26

Achado da investigação da fila de Conferência Prime
([`docs/DIAGNOSTICO-CONFERENCIA-PRIME-2026-10-26.md`](../DIAGNOSTICO-CONFERENCIA-PRIME-2026-10-26.md)).
Medido em produção, somente leitura. **Nada foi alterado em código, SQL ou
dado.**

## FATOS COMPROVADOS

Cada um foi medido por consulta direta em produção em 26/10/2026.

1. **O espelho não filtra nada; é `paymentDate` que nunca vem nulo.**
   `public.prime_extrato` tem **417.072 linhas** e **0 (zero) com `liquidado_em`
   nulo** — mas isso **não** é efeito de filtro no ingestor.

   > ⚠️ **CORREÇÃO DE 26/10/2026, mesma data.** A primeira redação desta seção
   > afirmava que o espelho "só persiste linha liquidada". **Estava errado**, e
   > a correção está registrada aqui em vez de apagada, porque muda a conclusão
   > técnica: a proposta de "corrigir o ingestor para persistir a linha não
   > liquidada" **deixou de existir**, já que não há filtro para remover nem
   > linha nula para persistir.

   O que o código faz, conferido linha a linha em
   `supabase/functions/prime-extrato/index.ts`:

   - o ingestor chama `/students/{matricula}` (`student_composite`, que devolve
     o extrato inteiro sem paginar) e **aceita toda linha de
     `financialStatement` que tenha boleto** — sem nenhum filtro de liquidação,
     de portador ou de situação (linha 123: `liquidado_em: dia(l.paymentDate)`);
   - o helper `dia()` **preserva o nulo** (linha 78):
     `const dia = (v) => { const s = String(v ?? ""); return s.length >= 10 ? s.slice(0,10) : null; }`
     — campo ausente vira `""`, que tem menos de 10 caracteres, e grava `null`.
     **Se a API devolvesse `paymentDate` nulo, o espelho gravaria nulo.**

   Logo os zero nulos são **comportamento da API**, medido indiretamente mas com
   amostra que é praticamente o universo: 417.072 linhas, 9 portadores, 18.266
   alunos, coleta de 24 a 26/10/2026.

2. **`paymentDate` não é prova de pagamento.** No mesmo espelho não filtrado:

   | Portador | Linhas | `liquidado_em` nulo | A vencer | A vencer **com** data |
   |---|---:|---:|---:|---:|
   | 95 | 315.667 | **0** | 19.315 | **19.315** |
   | 195 | 80.350 | **0** | 1 | 1 |
   | outros 7 | 21.055 | **0** | 0 | 0 |

   **19.315 títulos a vencer no portador 95 têm `paymentDate` preenchido.** Um
   título que ainda não venceu não pode ter sido pago. Isto confirma, em escala
   1,4× maior e agora em **todos** os portadores, o que a sondagem de 28/09/2026
   já havia medido no 95 (0 de 302.477 nulos) — e vale como regra: **`paymentDate`
   preenchido não autoriza nenhuma conclusão sobre pagamento.**

3. **O espelho nunca remove linha.** O `upsert` é por `(matricula, boleto)`
   (`onConflict: "matricula,boleto"`), sem `delete`: 417.072 linhas para 417.072
   boletos distintos. Um boleto que a Prime deixe de devolver **mantém a linha
   antiga**, com o `coletado_em` velho. É por isso que o espelho não tem estado
   "reaberto" — não porque filtre, mas porque a API não expressa reabertura neste
   campo e a linha antiga sobrevive.

4. **A condição de saída automática da fila é logicamente inalcançável.**
   `public.prime_liquidacao_reavaliar_pendentes()` — chamada ao fim de
   `prime_liquidacao_classificar_novas()`, que roda de hora em hora pelo cron 54
   (`prime_liquidacao_classificar_hora`), com a triagem no cron 55 — tem como
   único ramo de liberação automática:

   ```sql
   if (v_ev ? 'prime') and v_liq is null then   -- "a Prime reverteu a liquidação"
   ```

   Esse ramo **não pode ser verdadeiro por nenhum caminho**:

   - **se o espelho tem a linha do boleto:** `liquidado_em` nunca é nulo (fato 1),
     logo `v_liq is null` é falso;
   - **se o espelho não tem a linha:** `prime_liquidacao_evidencias()` monta a
     chave `prime` como
     `case when liquidado_em is null and portador is null then null else ... end`
     e o retorno passa por `jsonb_strip_nulls` — a chave é removida, logo
     `v_ev ? 'prime'` é falso.

5. **O ramo nunca executou.** A classificação `PRIME_REVERTEU_LIQUIDACAO`, que
   só esse ramo escreve, **não aparece em nenhuma linha** de
   `prime_liquidacao_classificacao`. E das **768** decisões já tomadas em
   `prime_conferencia_decisao`, **zero** têm
   `decidido_por = 'prime_liquidacao@rotina'`: há 3 autores, todos humanos
   (`amanda.seibel`, `cobranca07` e um backfill rotulado de 08/10/2026).

6. **Os jobs estão saudáveis — o defeito não é de execução.** Crons 54 e 55:
   **168 execuções cada em 7 dias, 168 `succeeded`, 0 falhas**. A rotina roda,
   classifica (1.161 `PRIME_ORIGEM_NAO_COMPROVADA`, 115 `ACORDO_COMPROVADO`) e
   **nunca tirou uma linha da fila**.

7. **A coleta está fresca, e nenhum boleto da fila foi revertido de fato.** Os
   507 boletos pendentes do retrato de 16:37:20Z **estão todos no espelho e
   todos ainda liquidados**, com coleta entre 24 e 26/10/2026. Ou seja: o ramo
   morto não está escondendo reversão real conhecida hoje — está garantindo que
   uma reversão futura não seja vista.

## IMPACTO NA FILA DE CONFERÊNCIA PRIME

A fila (`prime_conferencia_decisao` com `decisao = 'PENDENTE'`) **não tem porta
de saída automática em funcionamento**. Consequências medidas:

- a fila só diminui por decisão humana, uma por título;
- um boleto que a ULBRA reabrir fica preso na fila **indefinidamente**, e
  enquanto está preso o título fica em `em_confirmacao`, isto é, **fora da
  cobrança e fora do saldo**. É perda de receita silenciosa: o aluno deixa de
  ser cobrado e ninguém é avisado;
- os ramos (b)/(c) da mesma função, quando a evidência sobe para
  `A_PAGAMENTO_COMPROVADO` ou `B_ACORDO_COMPROVADO`, apenas trocam o subgrupo e
  **mantêm `decisao = 'PENDENTE'`** — a fila também não libera o que ganhou
  prova.

O acoplamento título↔fila, por outro lado, está **correto e sem resíduo**:
`em_confirmacao` ⟺ `PENDENTE` exatamente, zero títulos decididos parados em
`em_confirmacao` e zero títulos em `em_confirmacao` sem linha de decisão. **O
defeito é a porta que não abre, não o estado que não acompanha.**

## RISCO DE INTERPRETAR AUSÊNCIA COMO REVERSÃO

Este é o ponto que qualquer correção precisa respeitar, e é uma regra, não uma
recomendação.

**Ausência de linha no espelho NÃO é prova de reversão.** São **três** coisas
diferentes, e o espelho sozinho não as separa:

| Fenômeno | O que é | Como aparece no espelho | Ação correta |
|---|---|---|---|
| **Boleto reemitido** | a mesma dívida ganha número novo (mesmo vencimento, mesmo principal) | a linha antiga envelhece e **surge outra** com o mesmo `vencimento` e `valor_bruto` | agir sobre o boleto **novo**; o antigo não é reversão |
| **Ausência no espelho** | a linha não voltou na recoleta do aluno | a linha antiga **permanece**, com `coletado_em` velho | **não fazer nada** — é sintoma, não fato |
| **Reversão comprovada** | a Prime reabriu o boleto | **não tem forma própria**: o campo que diria isso (`paymentDate`) nunca é nulo | exigiria prova positiva, que hoje não existe |

**E essa distinção foi medida, não presumida.** Em 26/10/2026, o conjunto dos
boletos cuja linha envelheceu enquanto o próprio aluno era recoletado:

- **1.009 boletos, 748 alunos** — todos os candidatos possíveis a "ausência";
- **991 deles (98,2%) têm substituto**: outro boleto do mesmo aluno, na coleta
  nova, com **mesmo vencimento e mesmo `valor_bruto`**. São **reemissões**;
- dos **18** restantes, **todos** são do portador 95 e **nenhum** está na nossa
  cobrança (`acordos_titulos`);
- **zero dos 1.009 estão no portador 195**, que é o portador da fila de
  Conferência Prime;
- apenas **1 dos 1.009** é conhecido em `acordos_titulos`.

**Consequência quantificada:** trocar a condição morta por
`not exists (linha no espelho)` **sem guarda** devolveria à cobrança **991
boletos que foram apenas reemitidos** — uma taxa de erro de **98,2%**. Não é
risco teórico; é número medido. Cobrança indevida nessa escala é dano externo e
de reputação, não erro de dado.

O inverso também vale e é o achado útil: **substituição é evidência positiva.**
Boleto novo com mesmo vencimento e mesmo principal diz que a dívida continua
viva, e diz isso **afirmando**, não por ausência. É o único sinal confiável
disponível hoje — e aponta para o boleto novo, nunca reabre o antigo.

Agravantes já documentados neste diretório, que tornam a ausência pouco
confiável como sinal:

- `prime_extrato` e `prime_extrato_fila` **não têm migration versionada** (ver
  "Drift de banco encontrado", acima): a rotina que as alimenta não é
  reproduzível a partir do repositório;
- a coleta é **por mutirão em fila** (crons 35, 40, 59, 60), não uma extração
  transacional e completa — não existe, hoje, marca de "esta rodada cobriu o
  universo X com sucesso";
- o matching do boleto usa `ltrim(boleto,'0')`, então uma divergência de
  formatação na origem também produz "ausência" (ver
  [prime-mapa-identificadores.md](prime-mapa-identificadores.md)).

**Portanto:** nenhuma liberação automática pode se apoiar em ausência enquanto
não existir prova de abrangência da extração. O que falta é um registro, por
rodada de coleta, de qual universo foi pedido, quantas linhas voltaram e se a
rodada terminou — e esse registro **não existe hoje**.

## H1 — RESULTADO (26/10/2026)

A H1 perguntava se o `financial_statement` devolve o título cuja liquidação foi
revertida, em especial com `paymentDate` nulo ou outro indicador explícito de
reabertura. **Resolvida sem chamar a API**, porque o espelho é cópia não
filtrada do extrato (fato 1) — a sonda autorizada **não foi executada**, e o
motivo está registrado abaixo.

- **H1.a — `paymentDate` nulo como sinal de reabertura: REFUTADA.** O campo
  **nunca é nulo**: 0 em 417.072 linhas, 9 portadores, incluindo **19.315
  títulos a vencer** no portador 95 (fatos 1 e 2). Um sinal que não ocorre não
  pode indicar nada. A refutação é forte porque o ingestor **preservaria** o
  nulo se existisse (helper `dia()`, linha 78).

- **H1.b — existir outro campo, não mapeado, que indique reabertura:
  INCONCLUSIVA.** O espelho só guarda os 13 campos que o ingestor mapeia, então
  **não é possível, pelo banco, afirmar que a API não devolva um campo
  adicional**. O registro oficial anterior (sondagem ao vivo de 28/09/2026) diz
  que `financialStatement` tem 13 campos e nenhum é situação, status ou saldo —
  mas confirmar que nada novo apareceu exige `prime-sonda` com `cru:false`.
  **Declarada inconclusiva de propósito**, e não refutada.

- **Por que a sonda não foi executada.** O portão da `prime-sonda` exige, além
  do JWT do gateway, **o token de rotina (segredo de ambiente) ou uma sessão de
  gestão** (ver `supabase/functions/prime-sonda/portao.ts`). Nenhum dos dois
  está disponível a uma sessão de leitura do banco, e extrair segredo de
  ambiente não é caminho aceitável. **Quem tiver sessão de gestão fecha a H1.b
  em uma chamada.**

- **Não existe caso de reversão conhecido e verificável.** Condição explícita
  da autorização, e ela se aplica: dos 1.009 candidatos a ausência, 991 são
  reemissão, os 18 restantes são do portador 95 e fora da cobrança, e **zero**
  estão no portador 195. Não há o que sondar que provasse reversão — e
  comportamento de reversão **não se infere de título liquidado**.

## HIPÓTESES AINDA NÃO COMPROVADAS

Nenhuma foi medida e nenhuma autoriza implementação.

- **H2.** Que a ULBRA efetivamente reverta liquidações com alguma frequência.
  **Não medido** — não há série histórica, e agora se sabe por quê: o campo que
  registraria o estado anterior nunca vem nulo, e a linha antiga sobrevive à
  recoleta (fato 3). No portador 195 **não há uma única ausência observada**, o
  que é ausência de evidência, não evidência de impossibilidade.
- **H3.** Que a coleta cubra 100% dos boletos da carteira. **Não verificado.**
  Continua sendo a lacuna que impede usar ausência como sinal — embora a
  medição dos 991 mostre que, mesmo com cobertura perfeita, ausência seguiria
  significando reemissão na grande maioria dos casos.

## CORREÇÕES PROPOSTAS — revisadas em 26/10/2026 pelo resultado da H1

> ⚠️ **O que saiu, e por quê.** A redação anterior desta lista trazia
> *"preferir corrigir o ingestor (persistir a linha não liquidada)"*. **Essa
> proposta foi retirada: ela não existe.** O ingestor já aceita todas as linhas
> e já preservaria o nulo — não há filtro a remover. A ordem de prioridade
> também mudou, e a justificativa está em cada item.

1. **Não implementar detecção de reversão por `paymentDate`.** É impossível: o
   campo nunca é nulo (H1.a refutada). Qualquer regra escrita sobre esse campo
   é código morto no dia em que nasce.

2. **Não implementar detecção de reversão por ausência.** Agora com número:
   erraria em **98,2%** dos casos (991 reemissões em 1.009 ausências). Esta é a
   recomendação mais forte da lista, e é uma proibição, não uma preferência.

3. **Remover ou neutralizar o ramo morto**, em vez de "corrigi-lo". O ramo
   `(v_ev ? 'prime') and v_liq is null` de
   `prime_liquidacao_reavaliar_pendentes()` não pode executar e não protege nada
   observável: no portador 195 não há uma única ausência. Código que não executa
   é dívida técnica disfarçada de proteção — e, enquanto parecer proteção,
   impede que alguém escreva a proteção de verdade.

4. **Usar substituição como sinal, porque é prova positiva.** Boleto novo com
   mesmo vencimento e mesmo `valor_bruto` é detectável hoje, no espelho, sem
   nenhuma dependência externa — e afirma que a dívida continua viva em vez de
   inferir a partir do que falta. Qualquer ação se aplica ao boleto **novo**.

5. **Liberação automática por prova de máquina: NÃO AUTORIZADA.** A redação
   anterior deste item propunha liberar automaticamente ao atingir
   `A_PAGAMENTO_COMPROVADO` ou `B_ACORDO_COMPROVADO`, e dizia que isso havia
   "subido de prioridade". **Retirado por decisão da gestão em 26/10/2026**,
   depois do backtest das 62 decisões já tomadas sobre linhas com prova de
   máquina — ver a seção dedicada no fim deste documento. A liberação segue
   **humana**.

6. **Drenar o estoque legado por causa, com aprovação da gestão**, não por
   boleto — e, na dúvida, `REJEITADO`: o título volta a `ABERTO` e volta a ser
   cobrável. O erro reversível é devolver à cobrança; o erro caro é encerrar
   dívida viva. **Subiu de prioridade** pelo mesmo motivo do item 5.

7. **Instrumentar a cobertura da coleta** — universo pedido, retorno e término
   por rodada. **Desceu de prioridade:** continua sendo pré-requisito de
   qualquer regra futura sobre ausência, mas deixou de ser urgente, porque
   nenhuma regra sobre ausência deve ser escrita (item 2).

8. **Fechar a H1.b** com uma chamada de `prime-sonda` (`cru:false`) a
   `/students/{registration}/financial-statement`, para listar os campos e
   confirmar que nada novo apareceu desde 28/09/2026. Precisa de sessão de
   gestão.

Detalhamento, números e recortes em
[`docs/DIAGNOSTICO-CONFERENCIA-PRIME-2026-10-26.md`](../DIAGNOSTICO-CONFERENCIA-PRIME-2026-10-26.md).

---

# Liberação automática por prova de máquina: NÃO AUTORIZADA — 2026-10-26

Backtest feito ao dimensionar a próxima prioridade da Conferência Prime.
Somente leitura. **Decisão da gestão: a liberação automática não está
autorizada** — nem por `A_PAGAMENTO_COMPROVADO`, nem por `A2_COBRE`.

## O universo analisado

Todas as linhas de `prime_conferencia_decisao` que **já foram decididas por um
humano** e que carregavam subgrupo de prova de máquina
(`A_PAGAMENTO_COMPROVADO`, `B_ACORDO_COMPROVADO` ou `A2_COBRE`):

| | Linhas | |
|---|---:|---|
| **Total decidido com prova de máquina** | **62** | |
| Humano **concordou** (`VINCULADO` / `CONFIRMADO`) | **58** | 93,5% |
| Humano **divergiu** (`REJEITADO`) | **4** | **6,5%** — R$ 2.405,00 |
| Outras decisões | 0 | |

Pendentes com prova de máquina **agora**: **0**. O backtest é histórico; não há
fila esperando essa decisão hoje.

## A decomposição importa, e desmente a leitura simples

Os 4 divergentes **não são um fenômeno só**. São dois, com padrões distintos, e
somá-los num único percentual confunde padrões de prova diferentes:

| Padrão | Subgrupo | Casos | Divergentes | Taxa | Motivo humano registrado |
|---|---|---:|---:|---:|---|
| **1** | `A2_COBRE` (heurística histórica de cobertura de valor) | 57 | **3** | 5,3% | "não é do mesmo acordo" |
| **2** | `A_PAGAMENTO_COMPROVADO` (padrão de prova atual) | 5 | **1** | **20%** | "não consta negociação dessa parcela" |

**Padrão 1 — três linhas, 24/09/2026, R$ 2.182,37.** Valores quase idênticos
(R$ 727,44 / 727,46 / 727,47), coorte de 18/09, 6 dias na fila. Nessas três a
evidência **não trazia** `pagamento_cobre_o_titulo`, **não trazia**
`acordo_composicao` e tinha `classificacao` nula. Ou seja: `A2_COBRE` era
**cobertura de valor**, não vínculo de pagamento comprovado — e é exatamente o
erro que este diretório já documenta como regra ("proximidade de data + valor
NUNCA é fonte de verdade sozinha"). O humano disse que o pagamento era de outro
acordo.

**Padrão 2 — uma linha, R$ 222,63.** Detectada em 09/10 pelo ramo (b)/(c) da
reavaliação (que reescreve `detectado_em`), decidida em 19/10 — **10 dias na
fila**. Aqui a evidência trazia `pagamento_cobre_o_titulo = true` e
`classificacao = PAGAMENTO_COMPROVADO`: é o **padrão de prova atual**, e o
humano rejeitou mesmo assim.

## O que a divergência NÃO prova

Registro explícito, porque é a leitura errada mais tentadora:

**A divergência, isoladamente, não comprova erro da máquina nem acerto da
decisão humana.** Nos quatro casos, nenhuma das duas afirmações está validada
por evidência independente no registro:

- o motivo humano ("não é do mesmo acordo", "não consta negociação dessa
  parcela") é **plausível e não verificado** — é texto livre, sem apontar o
  acordo correto nem a fonte consultada;
- a classificação da máquina é **derivada de regra**, e no padrão 1 a regra era
  reconhecidamente fraca (cobertura de valor);
- não existe terceira fonte, no registro, que decida entre as duas.

Portanto o 6,5% **não é taxa de erro da máquina**. É **taxa de desacordo**, e
desacordo sem árbitro não atribui culpa a nenhum dos lados.

## Os 4 casos: PENDENTES DE VALIDAÇÃO DE EVIDÊNCIA

Classificação formal dos quatro, para que não sejam citados como erro provado
nem como acerto provado:

> **Status: PENDENTE DE VALIDAÇÃO DE EVIDÊNCIA.** Requerem conferência caso a
> caso — no padrão 1, qual acordo de fato recebeu o pagamento; no padrão 2, se
> existe negociação para a parcela. Até que isso seja conferido, nenhum dos
> quatro conta como evidência a favor ou contra a automação.

Identificados neste diretório apenas por subgrupo, valor e data, **sem nome,
CPF, matrícula ou número de boleto** — a identificação operacional está no
banco, não em documentação versionada.

## Consequência para a automação

**A liberação automática por prova de máquina permanece não autorizada.** Vale
para `A_PAGAMENTO_COMPROVADO` **e** para `A2_COBRE`, e os motivos são
independentes do percentual:

1. **a direção do erro é a cara.** Uma liberação automática errada tira título
   da cobrança (`CONFIRMADO`/`VINCULADO`), que é o erro silencioso e difícil de
   notar — e não o reversível. O princípio já registrado neste diretório se
   aplica: na dúvida, `REJEITADO`;
2. **a amostra do padrão atual é de 5 casos.** Não sustenta nem autorização nem
   proibição estatística — e, justamente por isso, não autoriza automatizar;
3. **não há fila esperando:** 0 pendentes com prova de máquina hoje. O ganho
   seria zero agora, e o risco não.

**O que fica no lugar:** a prova de máquina continua sendo **sugestão forte na
tela**, com a evidência à vista, e a decisão continua expressa e humana. Se a
automação voltar à mesa, o pré-requisito é validar os 4 casos acima e
reconstruir o backtest **só** sobre o padrão de prova atual, com amostra que
sustente a conclusão.

## O que permanece válido dos registros anteriores

Nada do que estava documentado foi invalidado por este achado:

- `paymentDate` nunca é nulo (0 em 417.072) e H1.a segue **refutada**;
- H1.b segue **inconclusiva**;
- ausência no espelho segue sendo 98,2% reemissão, e **regra sobre ausência
  segue proibida**;
- o ramo morto da reversão segue morto, e segue valendo removê-lo em vez de
  "corrigi-lo";
- a drenagem do estoque por causa, com decisão humana, segue sendo a
  prioridade — e este achado a **reforça**, porque confirma que o julgamento
  humano é o que distingue os casos.
