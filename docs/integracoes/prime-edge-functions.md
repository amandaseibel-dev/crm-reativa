# Inventário de Edge Functions — Prime/ULBRA

Auditoria de todas as Edge Functions que chamam a API Prime/ULBRA (ou
manipulam dado dela), feita em 2026-09-22 contra o projeto Supabase
`ahattpqrjmhkzsmnbdzs`. Comparado contra `supabase/functions/` do repositório
no commit desta auditoria.

**Resultado:** 4 funções já estavam versionadas. **6 existiam só em
produção** — confirmando o item já registrado em
`docs/BACKLOG-TECNICO.md`. As 6 foram versionadas neste mesmo commit em
`supabase/functions/`, com o código exatamente como está em produção
(`get_edge_function` por slug). Nenhuma foi reimplantada — versionar é
diferente de reimplantar; o deploy continua sendo uma decisão separada.

## Já versionadas antes desta auditoria

| Função | Finalidade | Endpoint(s) Prime | Método | Leitura/escrita |
|---|---|---|---|---|
| `prime-sync` | Enriquece cadastro (telefone, endereço, curso, situação acadêmica) a partir da Prime | `/students?search=`, `/students/{reg}` | GET | Lê Prime; escreve só `prime_cadastro_sync` (espelho) e, na ação `aplicar`, `alunos` (só campo vazio) |
| `prime-cadastro` | Igual ao `prime-sync`, versão mais nova — inclui classificação de semestre por série de `documentNumber` | `/students?search=`, `/students/{reg}` | GET | Lê Prime; escreve `alunos` (complementa), `prime_titulo_semestre` |
| `prime-portador` | Varredura de filiação aos portadores 166/195 + modo pontual de confirmação ao vivo (com a cadeia de decisão agreements→financial-statement→166 documentada na Premissa 19/20) | `/students?carrierId=`, `/students/{reg}`, `/students/{reg}/agreements`, `/students/{reg}/financial-statement` | GET | Lê Prime; escreve `prime_portador_membro`, `prime_sync_cursor`; no modo pontual pode chamar RPCs que liquidam título via `conciliacao_liquidar_titulo_por_prime` |
| `prime-diagnostico` | Diagnóstico rápido (uma chamada de cada tipo, status/tempo/corpo) para distinguir defeito nosso de instabilidade da Prime | `/carriers`, `/students?carrierId=195`, `/students?search={cpf}` opcional | GET | Só lê, nunca grava |

## Versionadas nesta auditoria (existiam só em produção)

| Função | Finalidade | Endpoint(s) Prime | Método | Secrets | Leitura/escrita | Tabelas/RPCs | Callers | Segura para reuso? |
|---|---|---|---|---|---|---|---|---|
| `prime-acordo` | **Sonda**: varre `GET /students/{matrícula}` inteiro atrás de qualquer campo que pareça usuário/operador/responsável, em qualquer nível, PT/EN — para saber se dá para atribuir "quem fechou o acordo" pela Prime | `/students/{registration}` | GET | `PRIME_API_KEY` ou RPC `prime_chave_api()` | **Só lê**, nunca grava | nenhuma tabela; RPC só de leitura da chave | nenhum caller encontrado em `src/` ou outras functions — parece invocação manual/ad-hoc | SIM, é só leitura e devolve caminho+valor, nunca o objeto inteiro (evita vazar dado pessoal desnecessário) |
| `prime-extrato` | Espelha o extrato financeiro completo (decomposto: principal/desconto/multa/juros/honorário) de uma fila de matrículas | `/students/{registration}` | GET | idem | Lê Prime; escreve **`prime_extrato`** (upsert) | tabela `prime_extrato`, fila `prime_extrato_fila`, RPCs `prime_extrato_falhou`/`prime_extrato_ok` | cron `prime_extrato_mutirao` (job 35, `*/2 2-23 * * 6`) chama a função SQL `prime_extrato_mutirao()`, que faz `net.http_post` para esta função; a fila é alimentada por `prime_extrato_reenfileirar()` (job 40, `5 2 * * 6`) — **ambas identificadas e versionadas em 20/10/2026** (`20261020122217`) | SIM para leitura; **comentário de cabeçalho está desatualizado** — ver "Achado crítico" abaixo |
| `prime-titular` | Diz de quem é um CPF, pela `registrationData.fullName`/`socialName`/`originalName` da Prime — usado para corrigir CPF duplicado entre alunos diferentes | `/students/{registration}` | GET | idem | Só lê | nenhuma | manual (correção de cadastro por matrícula, em lote de até 40) | SIM |
| `prime-buscar-nome` | Busca candidatos por nome (`search`) quando o CPF certo de alguém precisa ser descoberto | `/students?search={nome}` | GET | idem | Só lê | nenhuma | manual, para conferência humana | SIM — nunca escreve, resultado é só para revisão |
| `prime-sonda` | **Sonda de rota genérica**: recebe um `caminho` arbitrário, faz um GET, devolve a FORMA da resposta (nomes de campo e tipos); `cru:true` devolve o conteúdo para conferir um caso concreto | qualquer, sob `/api` | GET | `PRIME_API_KEY`/`ROTINA_TOKEN`/`PRIME_CADASTRO_TOKEN` | Só lê, nunca grava | nenhuma | manual — é o instrumento de descoberta desta própria auditoria | SIM — é a ferramenta recomendada para qualquer descoberta futura de endpoint (ver `prime-api.md`) |
| `exportar-gestao` | **Não é específica da Prime**, mas exporta dados derivados dela (`revisao_prime_aluno`) em lote, contornando o corte de 1.000 linhas da API de leitura padrão | nenhum — só lê tabelas próprias do CRM | — | nenhum secret da Prime | Lê tabela permitida (`TABELAS = {'revisao_prime_aluno'}`), grava JSON num bucket privado, devolve URL assinada (10 min) | `revisao_prime_aluno`, bucket `fechamento-remuneracao` | manual, tela de gestão | SIM — allowlist de tabela fechada, nunca aceita SQL/bucket/caminho do cliente |

### Achado crítico: comentário desatualizado em `prime-extrato`

O cabeçalho da função (ainda em produção, versão 6) afirma que "a ligação
acordo × mensalidade... está na assinatura, validada 8/8: mensalidade no
portador 195 com `paymentDate` NÃO foi paga — foi NEGOCIADA, e as que dividem
a mesma `paymentDate` são do mesmo acordo." **Essa regra foi testada em escala
maior em 2026-09-01 e formalmente invalidada** (ver memória
`portador-195-com-data-igual-e-negociacao`): 100% dos títulos do portador 195
têm `paymentDate`, inclusive os que continuam ABERTO no CRM — o critério não
distingue nada, e os 1.217 vínculos criados sob essa regra foram revertidos no
mesmo dia.

A função em si **não aplica** essa regra — só espelha o extrato bruto em
`prime_extrato`, sem decidir vínculo nenhum. O risco é **documental**: quem ler
o comentário e reimplementar lógica em cima dele herda uma premissa já
derrubada. **Ação recomendada, não aplicada:** atualizar o comentário de
cabeçalho da função (`prime-extrato/index.ts`, linhas 11–17) apontando para a
invalidação, na próxima vez que a função for tocada por outro motivo — não
abrir mudança só para isso.

## Funções fora do repositório que restaram: nenhuma

Todas as 10 Edge Functions ativas em produção que tocam Prime/ULBRA (ou dado
derivado) estão listadas acima e agora versionadas. `list_edge_functions`
também mostra `documento-financeiro-url`, `foto-perfil-url`,
`whatsapp-webhook`, `whatsapp-send`, `whatsapp-sessao`, `whatsapp-midia`,
`whatsapp-enviar-documento` — nenhuma referencia Prime/ULBRA e ficam fora
deste inventário.

**Esta contagem é de 22/09/2026 e ficou para trás.** As três funções
`ulbra-*` não existiam quando ela foi feita — estão na seção seguinte,
acrescentada em 06/11/2026.

## Mensageria ULBRA (`crm.ulbra.ai`) — três funções, outra API

Acrescentado em **06/11/2026**, para cumprir a regra 2 do
[`README.md`](README.md) (toda Edge Function que toque Prime/ULBRA entra neste
inventário). As datas de criação no repositório, por `git log --diff-filter=A`,
**não são as mesmas para as três**:

- `ulbra-consultar` e `ulbra-leads-pendentes`: `24c482f4`, **03/11/2026**
  (PR #794) — fora do inventário desde então;
- `ulbra-atendimento`: `4b840239`, **05/11/2026** (PR #814), junto com
  `src/components/AtendimentoUlbra.jsx`.

**Não falam com a API Prime.** O destino é o endpoint MCP JSON-RPC 2.0
`https://crm.ulbra.ai/api/mcp`, sistema de atendimento/WhatsApp separado do
Prime, com credencial própria (`ULBRA_MCP_TOKEN`, Bearer) e limites próprios
(15 chamadas/min por conexão, 30/min por pessoa, **500/dia por pessoa**). Por
isso a regra dos cinco arquivos do Prime (`prime-api.md` +
`prime-api-catalog.json` + `prime-mapa-fontes-verdade.md` + identificadores +
gaps) **não se aplica** a elas: a fonte de verdade da Mensageria é
[`mensageria-ulbra.md`](mensageria-ulbra.md), documento próprio na tabela do
`README.md`. O que se aplica é este inventário.

| Função | Finalidade | Ferramenta MCP | Portão | Leitura/escrita | Callers |
|---|---|---|---|---|---|
| `ulbra-consultar` | Vincula o aluno do CRM ao cliente da Mensageria e devolve a URL do atendimento | `conferir_duplicidade` (1 chamada, telefone **e** CPF nas duas posições) | JWT + usuário ativo em `public.usuarios`; operador só alcança aluno da própria carteira; perfis amplos (`supervisor`, `gerencia`, `administrativo`) alcançam qualquer um | Lê Mensageria; escreve **`ulbra_vinculos`** e `auditoria` (`ULBRA_CONSULTA`, `ULBRA_VINCULO_CRIADO`, `ULBRA_VINCULO_BLOQUEADO`) | `src/components/BlocoUlbra.jsx` |
| `ulbra-atendimento` | Atendimento atual do aluno, para o bloco da ficha | `listar_atendimentos` (`{cliente, limite: 1}`) — **e só ela**; `consultar_atendimento` existe no catálogo da Mensageria mas **não é chamada** por nenhuma função | Mesmo portão da `ulbra-consultar` em substância (mesma lista de perfis, mesmo recorte por `responsavel_atual_email`), porém **reimplementado** em `index.ts` em vez de importar `portao.ts`; lê vínculo filtrando `confianca = 'alta_cpf'` (`vinculoConfirmado`), antes de qualquer consulta | **Só lê**; cache em memória de 5 min (`TTL_MS`), nunca grava | `src/components/AtendimentoUlbra.jsx` |
| `ulbra-leads-pendentes` | Lista leads receptivos em `waiting` da equipe "Reativa" | `listar_atendimentos {situacao:"waiting"}` | JWT; `receptivo` da própria linha **ou** `usuario_e_gestao()` | **Só lê**; devolve apenas id, nome e data — sem CPF e sem telefone | `src/components/NotificacoesUlbra.jsx`, que **não está montado** em nenhuma página (polling de 60 s estouraria o limite diário) |

### Divergência repo × produção, medida em 06/11/2026

Vale o mesmo princípio das 6 funções desta auditoria: **versionado não é
publicado.** Lido por `list_edge_functions` e `get_edge_function`:

| Função | Produção |
|---|---|
| `ulbra-consultar` | `version 2`, de 03/11 — **a da PR #794**. Busca por telefone (CPF só como *fallback*), grava `confianca: 'alta'`, **não escreve auditoria** e devolve `url` para qualquer vínculo ativo |
| `ulbra-leads-pendentes` | `version 2`, de 03/11 |
| `ulbra-atendimento` | **não existe** — nunca publicada, embora `AtendimentoUlbra` esteja montado na ficha e a chame |

A correção do vínculo (PRs #813, #818, #819, #821) está na `main` e **não está
em produção**. A sequência de publicação e validação está em
[`mensageria-ulbra.md`](mensageria-ulbra.md), seção "Sequência de publicação".
Nada foi publicado nesta alteração — documentar é diferente de implantar.

## Autenticação, em duas famílias

- **Rotina noturna / cron:** header `x-rotina-token`, validado contra o
  Vault via RPC `prime_cadastro_token_valido` (só `service_role` pode chamar a
  RPC).
- **Gestão pela tela:** sessão do usuário, checada por
  `usuario_e_gestao()` no banco — nunca uma lista hardcoded no front.

A chave da Prime nunca é passada pelo cliente: sai do secret de ambiente
`PRIME_API_KEY` ou, quando ausente, de uma RPC que lê o Vault
(`prime_api_key_backend()` **ou** `prime_chave_api()` — duas RPCs equivalentes
que fazem a mesma coisa; ver `docs/integracoes/prime-gaps.md`).

## Órfãs no banco (não são Edge Function, mas seguem o mesmo padrão de "só em produção")

Ver `docs/integracoes/prime-gaps.md` para o detalhe de `prime_chave_api()`,
`prime_extrato` e `prime_extrato_fila` — existem em produção sem migration
correspondente no repositório.

## `prev-sincronizar` (criada em 28/09/2026 — frente PREVENTIVO)

| Item | Valor |
|---|---|
| Endpoint do Prime que chama | `GET /students/{registration}` (`student_composite`) |
| O que grava | `netAmount`, `grossAmount`, `paidAmount`, `paymentDate`, `dueDate` e `carrier`, todos com o nome do campo de origem, em tabelas `prev_*` |
| Escreve no Prime? | Não — a API não aceita escrita (`allow: GET`) |
| Escreve no CRM? | Só em tabelas `prev_*`, e só através da RPC `preventivo_sinc_gravar`. Zero escrita em tabela da cobrança |
| Secrets | `PRIME_API_KEY` (ou Vault via `prime_chave_api`), `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` |
| Acesso | exige JWT de usuário **e** `public.preventivo_e_gestao()` verdadeiro no banco — a lista de quem pode não mora no código da função |
| Granularidade | uma chamada **por aluno** da carteira preventiva, nunca por título (a API não tem rota em lote) |
| Fila própria | `prev_sinc_fila` — **não** reusa `prime_extrato_fila`, que varre os ~17,7 mil alunos da base e é drenada só no mutirão de sábado (`prime_extrato_mutirao`, `*/2 2-23 * * 6`) |
| O que nunca infere | `paymentDate` e `paidAmount` são copiados crus, com o nome do campo, e nunca lidos como data ou valor de recebimento; `netAmount` é tratado sempre como VALOR DO TÍTULO NA FONTE, nunca como valor em aberto; resposta com forma inesperada é ERRO, nunca "extrato vazio" |

Ver `docs/preventivo/README.md` para o desenho da frente e para o que ainda
falta de acesso.
