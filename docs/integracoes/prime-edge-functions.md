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
| `prime-extrato` | Espelha o extrato financeiro completo (decomposto: principal/desconto/multa/juros/honorário) de uma fila de matrículas | `/students/{registration}` | GET | idem | Lê Prime; escreve **`prime_extrato`** (upsert) | tabela `prime_extrato`, fila `prime_extrato_fila`, RPCs `prime_extrato_falhou`/`prime_extrato_ok` | rotina externa que alimenta `prime_extrato_fila` (não encontrada no repo — provavelmente cron/SQL direto em produção) | SIM para leitura; **comentário de cabeçalho está desatualizado** — ver "Achado crítico" abaixo |
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
