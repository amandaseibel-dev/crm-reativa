# Piloto com token pessoal da Mensageria (17/11/2026)

Alternativa ao OAuth, enquanto o `client_id` do ReATIVA não existe na Mensageria.
Escopo: **só a conta da gestora**, para leitura e resposta pela ficha. Sem implantação,
sem envio real e sem alterar o OAuth existente, que fica para evolução posterior.

## O que foi implementado (branch da #913, sem deploy)

- `supabase/functions/ulbra-conversa/token-pessoal.ts`: regra pura de cadastro.
  1. formato do token e validade (7, 30, 60 ou 90 dias);
  2. `meu_acesso` com o próprio token; a pessoa dona do token precisa ser o usuário
     logado (e-mail comparado sem maiúsculas, nunca pelo nome);
  3. só então grava, cifrado, sem `refresh_token`, com validade fixa.
- `index.ts`, ação `conexao_token_pessoal`: auditoria `ULBRA_CONEXAO_TOKEN_PESSOAL` em três registros,
  `TENTATIVA` (antes; se falhar, nada é tentado), depois `SUCESSO` ou `RECUSA` com o motivo, ou
  `RESULTADO_INCERTO` quando o banco não confirma. Sucesso só é registrado após a gravação atômica confirmada.
  A resposta não traz o token.
- `index.ts`, `conexao_desconectar`: para token pessoal, apaga a cópia local e **não**
  afirma revogação no provedor. Devolve `revogacao_manual_necessaria`.
- Configuração: envio, leitura e conexão de token pessoal exigem só `ULBRA_TOKENS_CHAVE`.
  `ULBRA_OAUTH_CLIENT_ID` e `ULBRA_OAUTH_REDIRECT_URI` deixam de bloquear essas ações.
  O OAuth (iniciar e concluir) continua exigindo as duas.
- Tela: `src/components/ConexaoTokenPessoal.jsx`, dentro do bloco de conexão da Central,
  com a mesma trava da Central (só aparece com a função respondendo).
  - campo de senha, `autocomplete=off`;
  - o valor fica só no estado do componente e é apagado em **qualquer** desfecho;
  - nada vai para `localStorage`, `sessionStorage` ou URL (há teste que prova).

## Como cadastrar o token (passo a passo, pela interface)

1. Na Mensageria, abra **MCP › Tokens pessoais** e clique em **Criar token**.
2. Nome: `reativa-piloto`.
3. Permissões (marque só estas; **não** marque campanhas, gestão, transferência, tickets ou operadores):
   - ver clientes
   - ver atendimentos
   - ler as conversas com os clientes
   - enviar mensagens e templates aos clientes dos seus atendimentos
4. Validade: **30 dias**.
5. Copie o token **uma vez**, ao final da criação.
6. No ReATIVA, abra a Central de Conversas, bloco de conexão, cole o token no campo
   "Token pessoal da Mensageria", escolha 30 dias e clique em **Cadastrar token**.
7. O campo é limpo logo após a resposta. Se a Mensageria recusar ou a conta não for a sua,
   a tela explica o motivo e nada é guardado.

Não envie o token por chat, e-mail ou commit.

## Escopos: o que é hipótese e o que falta comprovar

- Os quatro escopos acima são o **mínimo declarado** para leitura e resposta.
- Hipótese **não testada**: que "ver clientes" e "ver atendimentos" sejam necessários para
  ler a conversa. Se a leitura falhar com essa combinação, o teste real diz qual falta.
- A **autoria** (mensagem sair com o nome da dona do token) vem da descrição da ferramenta
  `enviar_mensagem_whatsapp`. **Não comprovada** até um envio real controlado.

## Expiração, desconexão e revogação: o que é comprovado

| Situação | Comportamento no CRM | Estado |
|---|---|---|
| Token vencido | Estado `EXPIRADA`; envio e leitura bloqueados (`conexao.ts`, sem refresh) | código e testes |
| Desconectar no CRM | Apaga a cópia cifrada; **não** revoga na Mensageria | código; revogação manual |
| Revogar na Mensageria | Chamadas com o token passam a responder 401/403; `chamarComoOperador` lança `ULBRA_AUTENTICACAO`, e leitura/envio não concluem (não há reconexão automática) | a confirmar no teste real |

Para revogar de fato: **MCP › Tokens pessoais › Revogar**, na Mensageria.

## Consumidores do `ULBRA_MCP_TOKEN` atual (inventário, sem valor do segredo)

O token atual é um **token pessoal da gestora** (aparece na aba Tokens pessoais com o nome
`ULBRA_MCP_TOKEN`, criado em 07/11/2026, vence em 07/12/2026). Lido por:

| Função | Arquivo | Uso |
|---|---|---|
| `ulbra-atendimento` | `supabase/functions/ulbra-atendimento/index.ts` | leitura da fila |
| `ulbra-consultar` | `supabase/functions/ulbra-consultar/index.ts` | identidade por CPF/telefone |
| `ulbra-diagnostico` | `supabase/functions/ulbra-diagnostico/index.ts` | diagnóstico (gestão) |
| `ulbra-leads-pendentes` | `supabase/functions/ulbra-leads-pendentes/index.ts` | leads pendentes |
| `ulbra-sincronizar` | `supabase/functions/ulbra-sincronizar/index.ts` | sincronização |
| `ulbra-historico` (v1) | **CONTIDA**: função excluída pela gestão (ausente da listagem; endpoint HTTP 404). Cópia preservada em `docs/integracoes/preservacao-ulbra-historico-v1-producao/`, sem restauração | histórico com credencial central (já não ativa) |

A `ulbra-conversa` (novo) **não** lê esse token para envio nem leitura individual.

## Evidência da exposição de 07/11

Registro em `docs/integracoes/mensageria-ulbra.md` (seção de credencial): o valor foi
cadastrado no **campo de nome** de um secret, legível em texto puro no painel para quem tem
acesso ao projeto. O cadastro malformado foi removido em 07/11, e o valor correto está no
lugar, mas **o valor exposto segue válido até ser trocado**. Este pacote não reproduz o valor.

## Rotação (não executada nesta etapa)

1. Criar o token de substituição na Mensageria (escopos mínimos, com a gestora).
2. Migrar as cinco funções para o novo valor. A `ulbra-historico` v1 já está CONTIDA (excluída;
   ausente da listagem; HTTP 404), então não há migração a fazer para ela.
3. Revogar o token antigo na aba Tokens pessoais.
4. Conferir que nenhuma função ainda lê o valor antigo.

Não revogar nem substituir sem sua decisão específica.

## Pré-condições para testar o piloto

- `ULBRA_TOKENS_CHAVE` configurada no ambiente da função `ulbra-conversa` (já prevista no pacote).
- Flags do servidor seguem desligadas até a decisão: `ULBRA_ENVIO_REAL`, `ULBRA_CONTRATO_PREVIA_CONFIRMADO`,
  `ULBRA_HISTORICO_HABILITADO` (leitura). `HISTORICO_DISPONIVEL` é só a porta de tela: fica `true` no merge, e
  o servidor nega a capacidade enquanto `ULBRA_HISTORICO_HABILITADO` estiver ausente (teste `index-handler.test.ts`, caso c1b).
- Contenção da v1 `ulbra-historico`: CONCLUÍDA (função excluída; ausente da listagem; endpoint HTTP 404). Evidência preservada; não é pendência.
- Grant de INSERT em `auditoria` para `authenticated` (A3): ver "Verificação A3" em `pacote-historico-e-resposta-2026-11-11.md`. Não bloqueia o piloto (RLS nega a inserção direta), mas o grant excessivo é pendência de higiene com dependência do frontend.
- Migrations `20261111140000` e `20261117120000` pendentes de aplicação com aprovação, nesta ordem.
  (`20261116150000`, corretiva da RPC de reserva, não é pré-requisito do piloto.)

## Testes

- `token-pessoal.test.ts`: 9 casos (token próprio grava sem devolver o valor; divergência
  de e-mail não grava; Mensageria recusa; indisponível; formato e validade; expiração).
- `ConexaoTokenPessoal.test.jsx`: 6 casos (campo protegido; apaga o valor em sucesso e em
  erro; mensagens; nada em storage).
- Suítes existentes de `ulbra-conversa`, `CentralConversas` e `CentralUlbra`: passam.

Rodado localmente com vitest. O Deno do `ulbra-conversa` roda só no CI.

## Sobrescrita de conexão OAuth (trilha A, caso do Guardião; histórico, superado pela seção "Proteção atômica")

- Risco: o `upsert` de `ulbra_conexoes_operador` é por e-mail. Gravar token pessoal sobre uma
  linha OAuth com `refresh_token` apagaria a cópia do refresh, deixando o grant válido no provedor
  sem controle.
- Correção: `conexao_token_pessoal` **recusa** com `409 CONEXAO_OAUTH_ATIVA` quando há conexão OAuth
  ativa com refresh. O operador desconecta o OAuth antes (o que tenta a revogação no provedor).
- **Desconexão OAuth sem confirmação do provedor:** o refresh cifrado fica guardado (A4) e
  `revogada_em` é preenchido. O guard **recusa** enquanto houver refresh cifrado, mesmo revogado,
  com `409 CONEXAO_OAUTH_ATIVA`. Para liberar, é preciso nova tentativa de desconexão que confirme a
  revogação no provedor. Não é liberado automaticamente.
- **Fail-closed em erro de leitura:** a consulta da conexão atual trata o erro do banco. Se não
  conseguir ler, responde `503 CONEXAO_NAO_VERIFICADA` e não grava.
- **Limites declarados do guard:**
  - (Superado nesta revisão: a leitura prévia foi substituída pela gravação atômica de `ulbra_gravar_conexao`; ver a seção "Proteção atômica" abaixo.)
  - o guard só considera conexão com `refresh_token`. Uma conexão OAuth **sem refresh** (trilha B,
    caso raro) é sobrescrita sem recusa, e o grant segue válido no provedor até expirar. Registrado;
- Estado real, consulta read-only em produção: a tabela `ulbra_conexoes_operador` **ainda não existe**
  (migration `20261111140000` não aplicada). Portanto não há linha OAuth da gestora hoje. O caso só
  se torna possível após aplicar a migration e conectar por OAuth; a recusa acima o cobre.

## Limitações declaradas

- **Conexão OAuth sem `refresh_token`** é tratada como "pessoal" em `conexao_desconectar`
  (`refresh_token === null`). Para ela, o CRM apaga a cópia local e pede revogação manual,
  sem chamar o provedor. Não há coluna de tipo na tabela (criar uma exige migration, não feita).
- **Sem `ULBRA_OAUTH_CLIENT_ID`**, a renovação OAuth deve falhar e a conexão deve virar
  `EXPIRADA` (fail-closed). Não testado: nenhum teste prova a falha do provedor com `client_id` ausente. Antes, a ação devolvia 503 `CONEXAO_NAO_CONFIGURADA`; agora o erro sai pela
  renovação. Isso é mudança de comportamento e está declarada aqui.
- **Auditoria:** tentativa, sucesso, recusa e resultado incerto são registros distintos (ver topo).
  Falha ao gravar a tentativa impede a tentativa. Sucesso não é registrado antes da gravação confirmada.
- **Conclusão OAuth com erro da ferramenta** (`conexao_concluir`): responde 502 `MENSAGERIA_INDISPONIVEL`.
  O grant recém-emitido é descartado: revoga **access e refresh**, cada um por chamada, sem presumir cascata
  (`grant.ts`). Se a revogação falhar, o grant vai para **quarentena** (cifrado, marcado como revogado,
  sem pessoa), para que desconectar possa tentar revogar depois. Nunca é usado para leitura ou envio.
  Inclui 401/403 logo após emitir o token.
- **Wiring sem teste automatizado:** os caminhos de `index.ts` (identidade OAuth, token pessoal,
  wiring de `lerConversa`) não são cobertos pelos testes, que usam dependências simuladas.
  Verificados só por leitura e pela revisão do Guardião. Gap registrado.
- **Erro da ferramenta na identidade do token pessoal** é tratado como indisponibilidade
  (`ULBRA_MCP_ERRO` → `MENSAGERIA_INDISPONIVEL`), e não como `IDENTIDADE_DIVERGENTE`.
  `chamarComoOperador` devolve `{ dados, erro }` (`extrairResultado`, `index.ts:50-58`).
  Não há defeito de envelope: uma correção errada nesse ponto foi revertida.

## Proteção atômica da conexão (pré-requisito de implantação; NÃO ativa)

**Estado:** pendente de aprovação. Nada aplicado em produção. Enquanto a migration não for
aplicada, a tabela `ulbra_conexoes_operador` não existe e **nenhuma conexão pode ser gravada**
(fail-closed). Não há proteção ativa hoje.

**Migration:** `supabase/aguardando_aprovacao/20261117120000_ulbra_gravar_conexao_atomica.sql.pendente`
(+ `.rollback.sql`). Depende de `20261111140000` (cria a tabela). Cria `ulbra_gravar_conexao`:
- checagem e gravação **na mesma transação**, sob trava da linha (`SELECT ... FOR UPDATE`);
- recusa (`EXISTENTE`) quando já há access **ou** refresh cifrado, ativo ou revogado: não substitui
  silenciosamente nenhuma conexão, com ou sem refresh (trata o caso A4 também);
- só grava quando não há credencial (primeira conexão, ou após desconexão confirmada);
- execução só por `service_role`; `anon` e `authenticated` sem EXECUTE (conferido na própria migration).

**Usada por:** cadastro de token pessoal e conclusão OAuth. Erro **antes** da gravação não grava nada;
**erro depois do commit** (rede cai com a resposta) deixa a linha gravada, e o cadastro responde 503 mesmo assim
(ver "Erro ambíguo do banco" abaixo). Recuperação: desconectar e conectar de novo;
no cadastro responde 503 `CONEXAO_NAO_VERIFICADA`. Conclusão OAuth **recusada ou com erro de banco**
revoga o grant recém-emitido (melhor esforço), porque ele não será guardado.

**Erro ambíguo do banco (commit seguido de falha de resposta):** o token pessoal responde
`RESULTADO_INCERTO` (503) e **não afirma sucesso nem falha**; a auditoria registra `RESULTADO_INCERTO`.
Na conclusão OAuth, o handler descarta o grant novo, mas a linha pode ter sido gravada antes da falha:
fica com tokens de um grant já revogado (fail-closed para o uso; estado local inconsistente).
Recuperação: ver o estado na Central, desconectar e conectar de novo. Não há reconciliação automática.

**Renovação OAuth com compare-and-set (corrigida nesta revisão):** a renovação lê o estado (refresh cifrado e
`revogada_em`) antes da troca e grava **só se a linha continuar igual** (`UPDATE ... WHERE refresh_token_cifrado = <lido> AND revogada_em IS NULL`).
Uma desconexão ou conexão nova no meio da renovação faz a gravação não acontecer e os tokens recém-emitidos
são descartados (`renovacao.ts`). Não há mais `upsert` na renovação. Testado com linha em memória que simula a concorrência.

**Testes:**
- Unitários (local, Vitest): `grant.test.ts` (4: revoga access e refresh, quarentena, pendente), `renovacao.test.ts` (4: concorrência de desconexão e de conexão nova), `token-pessoal.test.ts` (9) e `token-pessoal-atomico.test.ts` (8),
  com armazenamento falso que serializa gravações. Erro de gravação sem gravação; OAuth com e sem
  refresh preservado; concorrência token x token e token x OAuth. Modelam a trava, não a provam.
- Banco real (CI, Postgres 17, job `ulbra-conexao-envio-sql`, passo novo):
  `supabase/tests/ulbra_conexao_token/run.cjs`. Duas conexões; a contenção é confirmada por
  `pg_stat_activity` antes da segunda gravar. **Não executado localmente** (sem Postgres nesta máquina).
  Só vale quando o job rodar verde.

**Limites que permanecem:**
- Tentativa recusada fica auditada como `RECUSA` (com o motivo). Sucesso só como `SUCESSO`.
- Troca de modalidade (OAuth para token, ou o inverso) exige **desconexão explícita** antes. A
  desconexão sem confirmação do provedor mantém o refresh e continua bloqueando (ver acima).
- Credencial OAuth ainda válida no provedor, em caso de falha de revogação, precisa de revogação
  manual na Mensageria, ou de desconexão posterior (quarentena). O comportamento do provedor ao revogar não foi comprovado.

**Rollback:** remove só a função. Sem ela, nenhuma conexão é gravada (fail-closed).

## Habilitação da interface (HISTORICO_DISPONIVEL) e bloqueio efetivo

- `src/utils/ulbraHistorico.js`: `HISTORICO_DISPONIVEL = true` **neste commit**, testado e revisado,
  e não na hora do merge.
- O bloqueio efetivo continua no backend: sem `ULBRA_HISTORICO_HABILITADO=true`, a função
  `historico_capacidade` responde `pode: false` (`historico-leitura.ts`, `capacidadeHistorico`).
  Sem capacidade, a Central não mostra o botão e não chama `historico_ler`.
- Testes desta combinação: `ulbraHistorico.test.js` (porta de tela ligada e sem capacidade = sem botão);
  `ulbraHistoricoSelecao.test.js` (vínculo confirmado é pré-requisito); `MensageriaPeriodo.historico.test.jsx`
  (porta desligada explícita = sem botão); `CentralUlbra.test.jsx` (capacidade negada = sem chamada).
- Observação de teste: no conjunto completo, `CentralUlbra.test.jsx` e `bordero.test.js` tiveram
  falha de tempo limite sob carga paralela; passaram isolados (93 testes). Declarado, não ignorado.

## Recuperação (corrigida)

**Não** usar "remover `ULBRA_TOKENS_CHAVE`" como recuperação: se houver tokens cifrados, a chave é
necessária para decifrá-los e para desconectar com segurança. Ela é preservada em todos os casos.

| Situação | Ação | Efeito | Não faz |
|---|---|---|---|
| Parar a leitura | remover `ULBRA_HISTORICO_HABILITADO` | leitura recusada (`HISTORICO_DESLIGADO`); botão some | não apaga dados |
| Parar o envio | `ULBRA_ENVIO_REAL` e `ULBRA_CONTRATO_PREVIA_CONFIRMADO` ausentes (estado inicial) | prévia e envio bloqueados | não apaga dados |
| Desconectar um operador | `conexao_desconectar` pela Central | apaga a cópia cifrada local; OAuth tenta revogar no provedor; token pessoal exige revogação manual em MCP › Tokens pessoais | não afeta outros operadores |
| Tirar a função de conexão do ar | despublicar `ulbra-conversa` | "função indisponível" na tela; nenhuma leitura nem gravação | não apaga tabelas nem segredos |
| Reverter a função atômica | `…atomica.rollback.sql` (só `DROP FUNCTION`) | nenhuma conexão nova é gravada (fail-closed) | não apaga conexões existentes |
| Reverter as tabelas | `…conexao_individual_e_envio.rollback.sql` | **recusa** se houver linhas em `ulbra_conexoes_operador`, `ulbra_conexoes_pedidos`, `ulbra_envio_previas` ou `ulbra_envios`; só executa com as quatro vazias | não é reversão com histórico: após uso real, desativar em vez de reverter |

- "Reimplantar versão anterior" **não se aplica**: `ulbra-conversa` não existe em produção, então não há
  versão anterior. A recuperação é despublicar (tabela de linha acima).
- Auditoria (`ULBRA_CONEXAO_TOKEN_PESSOAL`, `ULBRA_HISTORICO_LEITURA`) **não** é apagada por nenhum rollback.
- Aluno de teste: **nunca** excluído automaticamente na recuperação se já houver vínculo, atendimento ou
  histórico. A exclusão é decisão manual, caso a caso.
- A função antiga `ulbra-historico` **não** é restaurada em nenhum caminho.

## Aluno, vínculo e atendimento (etapas separadas)

1. **Cadastro do aluno:** pelo formulário existente, com CPF preenchido por você. Responsável inicial:
   a gestora. Não cria caso, título, acordo ou pagamento.
2. **Vínculo alta_cpf:** pela `ulbra-consultar` (publicada). Exige que o CPF bata com o cliente da Mensageria
   (conferido por leitura, sem repetir o valor). Não depende de atendimento.
3. **Atribuição do aluno a João:** mecanismo existente do CRM, a verificar antes de executar. **Não comprova**
   responsabilidade na Mensageria.
4. **Atendimento espelhado:** a sincronização (`ulbra-sincronizar`, publicada) espelha só atendimentos em
   espera (`situacao: "waiting"`). **Não** presumir que uma mensagem sua cria atendimento novo em espera;
   confirmar por leitura depois do envio.
5. **João assume:** `ulbra_atendimento_assumir` (publicada) exige espelho + vínculo `alta_cpf` + João logado.
   Só depois, `ulbra_atendimentos.responsavel_email` = João, e a leitura da ficha fica autorizada para ele.
6. **Leitura:** João usa a própria credencial individual. Não há leitura global para João.

## Quem consegue ler (verificado por teste)

- **Sem conexão individual ativa, não há leitura, mesmo com a flag ligada.** `historico-sem-conexao.test.ts`:
  a função pura `lerHistoricoAutorizado` devolve 403 `SEM_CONEXAO`, não chama a Mensageria e não grava auditoria de leitura. Também coberto no handler real por `index-handler.test.ts` (execução de `index.ts` com banco e Mensageria falsos).
- **Sem fallback de credencial central.** Nenhum arquivo da função lê `ULBRA_MCP_TOKEN` fora de comentário,
  e a leitura usa só o token do próprio operador (`chamarComoOperador`). Verificação **estrutural** (texto do código atual, não prova de comportamento em execução nem de ausência de fallback futuro).
- **Habilitada ≠ apta.** Habilitada = `ULBRA_HISTORICO_HABILITADO=true`. Apta = habilitada + identidade
  na lista do piloto + conexão individual ativa + permissão da regra permanente.
  - **Dono da carteira** = operador de caso ATIVO. Caso encerrado (`caso_encerrado_operacional` verdadeiro) não autoriza
    leitura, mesmo que o operador tenha sido o dono. Erro ao verificar também não autoriza (fail-closed).
  - **Responsável atual** = responsável do atendimento não dispensado, comprovado pelo atendimento. A situação do caso não o afeta (decisão registrada em `decisoes-integracao-ulbra.md`). Antigo dono de caso encerrado não autoriza.
  - **Erro na verificação de encerramento** de qualquer caso: ninguém é dono (fail-closed).
  - **Leitura global** (decisão de gestão, sem mudança nesta rodada): `amanda.seibel@aelbra.com.br` e
    `cobranca04@aelbra.com.br` (Fernanda), exigindo usuário ativo. Qualquer outro operador segue a regra acima.
  - Prova no handler real: `index-handler.test.ts` (casos de encerrado, negado sem auditoria, e positivo com auditoria gravada antes do texto).
- **Configurar só o token do João não limita o piloto:** a flag é global, e qualquer operador com
  carteira ou responsabilidade e conexão ativa passaria nas regras permanentes.
- **Restrição de piloto:** `ULBRA_HISTORICO_PILOTO_EMAILS` (e-mails separados por vírgula). Fail-closed:
  lista ausente ou vazia = ninguém lê. Não altera as regras permanentes. `piloto-leitura.ts` e
  `piloto-leitura.test.ts`. Para o piloto: `cobranca10@aelbra.com.br`. Identidade observada na interface (CRM: usuário
  ativo com nome João; Mensageria: mesmo e-mail na fila de atendimento). **Não versionado no repositório**; informado e
  observado pela gestora, não verificado por teste. O wiring de `index.ts` (linha de `flagLigada`) não tem teste: gap declarado.
  Usuário fora da lista recebe `HISTORICO_DESLIGADO` (mensagem genérica, não motivo de piloto).

## Atribuição do aluno a João (leitura, sem execução)

- Mecanismo existente encontrado: `vincular_responsavel_caso(uuid[], text)` (migration `20260911100000`).
  Só Amanda e Fernanda podem chamá-la, e só define o responsável de aluno **sem responsável**
  (`responsavel_atual_email is null`).
- O cadastro pelo formulário grava a criadora como responsável inicial. Logo, esse caminho **não se aplica
  diretamente** ao aluno de teste. Não encontrei outro mecanismo verificado de troca de responsável.
- Nada foi executado. A atribuição a João fica pendente de definição do caminho, e não é comprovação de
  responsabilidade na Mensageria.

## O que continua não comprovado

- Criação de atendimento em espera por mensagem recebida (etapa 4).
- Formato de sucesso e recusa da Mensageria no envio (permanece desligado).
- Itens da lista anterior.

- Autoria real da mensagem e permissões mínimas: só com envio real controlado, aprovado.
- Comportamento do token revogado na Mensageria: só com teste real.
- Leitura real da conversa com o token pessoal: só com o token criado por você.

## Grant OAuth sem cópia quando a revogação falha (caminho exclusivo do OAuth; indisponível no piloto)

- **Caminhos exatos** (`supabase/functions/ulbra-conversa/index.ts`): conclusão OAuth (`conexao_concluir`) nos ramos
  de identidade divergente, erro de banco e conexão existente, e a renovação recusada por conexão mudada.
  A quarentena (guarda cifrado para revogar depois) só existe no ramo indisponível (`grant.ts`).
- **Tipo de token afetado:** access e refresh de um grant OAuth. Nunca o token pessoal: o caminho do token
  pessoal não chama `descartarGrant` nem `revogar` (ver as linhas de `conexao_token_pessoal`).
- **Pode ocorrer no piloto?** Não. Três fatos comprovados:
  1. `conexao_iniciar` e `conexao_concluir` exigem `ULBRA_OAUTH_CLIENT_ID` e `ULBRA_OAUTH_REDIRECT_URI`
     (`configuracao-acao.ts`, teste `configuracao-acao.test.ts`). No piloto essas variáveis **não são configuradas**:
     a ação responde 503 `CONEXAO_NAO_CONFIGURADA` antes de trocar o código. Nenhum grant é emitido.
  2. A renovação só roda com `refresh_token` e estado `EXPIRANDO` (`conexao.ts`). Token pessoal não tem refresh:
     vira `EXPIRADA`, sem renovação.
  3. Sem grant OAuth gravado, não há linha OAuth para renovar.
- **Regra de implantação do piloto:** NÃO configurar `ULBRA_OAUTH_CLIENT_ID` nem `ULBRA_OAUTH_REDIRECT_URI`.
  Verificação pós-deploy: `conexao_iniciar` responde 503 `CONEXAO_NAO_CONFIGURADA`.
- **Antes de qualquer habilitação futura do OAuth:** decisão da gestão sobre o risco (ver decisoes-integracao-ulbra.md).
  Esta entrega não desenvolve solução ampla de OAuth.

