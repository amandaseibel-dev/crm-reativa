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
| **Reversão de liquidação (boleto que volta a aberto na Prime)** | 🔴 VERMELHO | **Não — não é observável pelo espelho** | `prime_extrato` só persiste linha liquidada | **NÃO** | Medido 26/10/2026: **417.072 linhas, 0 com `liquidado_em` nulo**. O espelho não tem estado "reaberto", e ausência de linha não distingue reversão de coleta incompleta. Ver a seção dedicada abaixo |
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

1. **O espelho só contém registro liquidado.** `public.prime_extrato` tem
   **417.072 linhas** e **0 (zero) com `liquidado_em` nulo**. A tabela não tem
   como representar o estado "boleto reaberto": a ausência de liquidação não é
   um valor que ela guarde, é uma linha que não existe.

2. **A condição de saída automática da fila é logicamente inalcançável.**
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

3. **O ramo nunca executou.** A classificação `PRIME_REVERTEU_LIQUIDACAO`, que
   só esse ramo escreve, **não aparece em nenhuma linha** de
   `prime_liquidacao_classificacao`. E das **768** decisões já tomadas em
   `prime_conferencia_decisao`, **zero** têm
   `decidido_por = 'prime_liquidacao@rotina'`: há 3 autores, todos humanos
   (`amanda.seibel`, `cobranca07` e um backfill rotulado de 08/10/2026).

4. **Os jobs estão saudáveis — o defeito não é de execução.** Crons 54 e 55:
   **168 execuções cada em 7 dias, 168 `succeeded`, 0 falhas**. A rotina roda,
   classifica (1.161 `PRIME_ORIGEM_NAO_COMPROVADA`, 115 `ACORDO_COMPROVADO`) e
   **nunca tirou uma linha da fila**.

5. **A coleta está fresca, e nenhum boleto da fila foi revertido de fato.** Os
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

**Ausência de linha no espelho NÃO é prova de reversão.** As duas hipóteses são
indistinguíveis pelo espelho sozinho:

| O que ausência pode significar | Ação correta |
|---|---|
| a Prime reabriu o boleto (reversão real) | devolver o título à cobrança |
| a coleta não trouxe aquele aluno/boleto nesta rodada | **não fazer nada** |

Trocar a condição morta por `not exists (linha no espelho)` **sem guarda** é
pior do que o defeito atual: uma coleta parcial, um erro de autenticação, uma
janela de manutenção da ULBRA ou um lote que falhou devolveriam à cobrança
alunos cujo boleto segue liquidado — cobrança indevida em massa, que é dano
externo e de reputação, não só erro de dado.

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

## HIPÓTESES — NÃO COMPROVADAS

Marcadas como hipóteses de propósito; nenhuma foi medida e nenhuma autoriza
implementação.

- **H1.** Que a API da Prime devolva, em `financial_statement`, a linha do
  boleto reaberto com `paymentDate` nulo. **Não testado.** O espelho não
  guardaria essa linha hoje de todo modo (fato 1), então a hipótese só pode ser
  verificada chamando a API, com `prime-sonda`, não lendo o banco. Se for
  verdadeira, a correção certa é no **ingestor** (passar a persistir a linha não
  liquidada), não no consumidor.
- **H2.** Que a ULBRA efetivamente reverta liquidações com alguma frequência.
  **Não medido** — não há série histórica, justamente porque o espelho não
  retém o estado anterior. O volume do risco é, por ora, desconhecido.
- **H3.** Que a coleta semanal cubra 100% dos boletos da carteira. **Não
  verificado.** É exatamente a lacuna que impede usar ausência como sinal.

## CORREÇÕES PROPOSTAS

Ordem deliberada: a proteção vem antes da automação.

1. **Não usar ausência como gatilho** enquanto não houver prova de abrangência
   da coleta. Regra, não preferência.
2. **Instrumentar a coleta primeiro:** registrar por rodada o universo pedido, o
   que voltou e se terminou. Sem isso, qualquer detecção de reversão é um palpite
   com efeito financeiro.
3. **Preferir corrigir o ingestor** (persistir a linha não liquidada, se H1 se
   confirmar na sonda) a inferir reversão por ausência no consumidor. A
   evidência positiva é sempre melhor que a negativa.
4. **Liberar automaticamente só com prova positiva:** quando a evidência atinge
   `A_PAGAMENTO_COMPROVADO` ou `B_ACORDO_COMPROVADO`, aplicar a mesma decisão
   que o fluxo novo já aplicaria a um título novo, com autoria
   `prime_liquidacao@rotina` e motivo explícito.
5. **Drenar o estoque legado por causa, com aprovação da gestão**, não por
   boleto — e, na dúvida, `REJEITADO`: o título volta a `ABERTO` e volta a ser
   cobrável. O erro reversível é devolver à cobrança; o erro caro é encerrar
   dívida viva.

Detalhamento, números e recortes em
[`docs/DIAGNOSTICO-CONFERENCIA-PRIME-2026-10-26.md`](../DIAGNOSTICO-CONFERENCIA-PRIME-2026-10-26.md).
