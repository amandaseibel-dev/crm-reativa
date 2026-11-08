# Mensageria ULBRA — desenho da operação (indicadores, responsável, lacunas)

Status: **desenho e lacunas. Nada implementado, nada aplicado, nenhuma
transferência real executada.** O piloto de observação da #861 não foi
ampliado. Data de referência: 08/11/2026.

Fontes usadas: `docs/integracoes/README.md`, `docs/integracoes/mensageria-ulbra.md`
(medido em 04/11/2026) e os **esquemas** das ferramentas do conector
Mensageria listados nesta sessão (carregados sem chamar nenhuma delas).

## 0. Diagnóstico do backend (sanitizado, #854)

Resultado do `ulbra-diagnostico` com o token de backend, conforme relatado
pela gestão em 08/11/2026. Os números vêm da gestão; não há lista de escopos
colada no repositório.

| Item | Resultado |
|---|---|
| Tipo de conexão | token de backend (`ULBRA_MCP_TOKEN`) |
| Escopos | 18 |
| Ferramentas | 60 |
| Cobertura declarada | conversas, envio e gestão de atendimentos |

**Não comprovado (manter assim até medição específica):**
- alcance dos dados (quais equipes, quais clientes, quais conversas);
- compartilhamento de cota entre o token de backend e o OAuth de gestão;
- disponibilidade de webhook ou evento de recebimento.

O token de backend **não** foi usado nesta documentação. Não repetir o
diagnóstico para obter estes números.

## 1. Divergência de fonte (já tratada pela #854/#861)

`mensageria-ulbra.md` (04/11) documenta **8 ferramentas** e declara
"Não expostos: conversas, mensagens, envio, campanhas, templates,
transferência de atendimento". Isso está **desatualizado**.

Já comprovado por outros PRs, sem repetir aqui:
- **#854 (mesclada):** `ulbra-diagnostico` chama `meu_acesso` e `tools/list`
  com o token de backend e devolve nomes de ferramentas, escopos e limites.
  Não devolve a credencial nem dado de aluno.
- **#861 (aberta, rascunho):** pacote de aprovação em
  `docs/integracoes/ulbra-etapa1-pacote-aprovacao.md` (branch
  `feat/ulbra-etapa1-recebimento`). Registra `pessoaPorDia`: limite 500,
  restam 443, medido em 07/11 pela conexão OAuth de gestão.

Pendência ligada a isso: atualizar `mensageria-ulbra.md` na mesma alteração
que incorporar essas medições. Não foi feito aqui.

## 2. Suporte real ao e-mail (não presumir o WhatsApp)

Pelos esquemas, o conector **tem** superfície de e-mail:

| Capacidade | Ferramenta | Observação |
|---|---|---|
| Listar caixa de e-mail | `listar_conversas` com `canal: "email"` | filtro por situação; páginas de até 50 |
| Ler e-mail | `ler_conversa` | traz assunto no e-mail; anexo só nome e tipo |
| Triagem | `triar_email` (`encaminhar` / `nao_relevante`) | cria atendimento na fila da equipe sem assumir pela pessoa |
| Acompanhar envio | `acompanhar_campanhas_email` | só campanhas de saída, não recebimento |

Comprovado nesta rodada (4 leituras, sem conteúdo de mensagem neste
relatório):
- `listar_conversas` com `canal: "email"` devolve conversas com `canal`,
  `situacao`, `cliente{id,nome}`, `equipe`, `responsavel` (**nome, não id**),
  `ultimaMensagem{quem, em, trecho}` e `paginacao.total`. Havia **129**
  conversas de e-mail na caixa visível a esta conexão.
- `ler_conversa` de uma conversa de e-mail devolve mensagens com `quem`,
  `autor` (nulo para o cliente), `tipo`, `texto`, `transcricao`, **`assunto`**
  e `anexos`. O texto do cliente pode trazer a citação inteira da mensagem
  anterior da ULBRA. Para contar mensagem ou lead, isso precisa de regra
  própria: a citação não é mensagem nova.

Evento/webhook de recebimento: **ainda não verificado.** Os esquemas e as
respostas acima não mostram nenhum. Sem evento, o painel só conhece entrada
por consulta, e o custo de polling depende do orçamento (seção 8, item 7).

**Deduplicação do e-mail (regra):** a unidade é o **ID da mensagem**
(`mensagens[].id` de `ler_conversa`), não o texto. Uma mensagem que cita a
anterior da ULBRA conta uma vez. A citação ("escreveu:", linhas com `>`) é
descartada na contagem. Não reconstruir mensagem a partir de citação.

Lacunas do e-mail:
- A **fila de triagem da supervisão** (e-mail sem responsável) fica fora do
  alcance do agente; entradas sem responsável não são contáveis por ele.
- Não se sabe se o e-mail entra como "lead" pelo mesmo caminho de
  `conferir_duplicidade` (que aceita `email`, mas não foi medido com e-mail real).

## 3. Mecanismos de transferência e responsável na ULBRA

| Mecanismo | Quem pode | Efeito | Limite |
|---|---|---|---|
| `transferir_atendimento` com `atendente` | supervisor, diretor ou admin | vai direto para o operador | destino precisa de perfil operador em equipe do requisitante |
| `transferir_atendimento` só com `equipe` | operador (para qualquer equipe dele), supervisor/diretor (para as deles) | volta para a distribuição da equipe | mesma equipe = redistribuir |
| `transferir_em_lote` | só supervisor, diretor, admin | move até 50 por chamada | **prévia por padrão**; `previa: false` grava |
| `assumir_ou_devolver_ao_bot` | operador da conversa | WhatsApp: pausa ou religa o bot; se a conversa não tem responsável, fica com quem assumiu | não envia nada ao cliente |
| `triar_email` | operador ou supervisor com alcance | e-mail: encaminhar à equipe ou arquivar | não cria segundo atendimento se já existe |

Regras já escritas nos esquemas, que o desenho deve preservar:
- **Carteira não muda por transferência.** Todas as transferências dizem
  "nunca edita cadastro nem carteira". A carteira de quem é o aluno continua
  sendo regra do ReATIVA; a ULBRA só move o **atendimento**.
- **Exclusividade de equipe:** `CONTACT_LOCKED` (cliente em atendimento
  exclusivo de outra equipe) e `TICKET_ATIVO_EXISTENTE` (ticket encerrado de
  quem já tem outro ativo) recusam a transferência, sem forçar.
- **Repetir não duplica:** `sem_mudanca` nas transferências e `ja_existia` na
  triagem de e-mail.

## 4. Responsável: ReATIVA como referência

Regra proposta: **o responsável da operação é o operador da carteira no
ReATIVA.** A ULBRA é o canal; o atendimento segue o responsável do ReATIVA,
e a divergência é tratada como incidente, não como novo dono.

Comprovado nesta rodada:
- `listar_atendimentos` devolve `atendente` como **nome de exibição**
  (ex.: "João Vitor", "Luana Marques"), sem id. `listar_conversas` devolve
  `responsavel` também como **nome**.
- `listar_equipes` sem parâmetro devolve as equipes com id: "Reativa"
  (principal) e "Ações Reativa".
- **`listar_equipes` com `equipe` devolve os membros com `id` de 24
  caracteres**, nome, perfis, `principal` e `naFila`. Contrato lido nos
  esquemas e **confirmado por 1 chamada** nesta rodada: a equipe Reativa tem
  13 membros, com perfis `operator`, `supervisor`, `diretor` e `gestao`. Os
  nomes são únicos nessa lista. Não traz e-mail nem telefone.
- Os nomes de `listar_atendimentos` e `listar_conversas` batem com os da
  lista de membros (ex.: "João Vitor", "Luana Marques", "Nataly Pereira").
- A equipe "Reativa" tem **41.929** atendimentos visíveis a esta conexão.

Lacunas de identidade:
1. **Identidade de operador (resolvida em parte):** o id do atendente **vem
   de `listar_equipes` com `equipe`** (confirmado, seção acima), não depende
   da TI. Falta só o vínculo entre esse id e o e-mail do operador no ReATIVA,
   que não aparece na ULBRA (a lista não traz e-mail, por desenho). O ReATIVA
   usa e-mail como chave (memória `operador-a-chave-e-o-email-nao-o-nome`).
   Nome não é chave: pode repetir ou mudar, mesmo que hoje seja único.
2. **Perfil do token:** `transferir_atendimento` por `atendente` exige
   supervisor, diretor ou admin. Se o token da integração for de operador, a
   transferência direta é recusada, e só a devolução à equipe funciona.
   Medir com `meu_acesso` antes de desenhar a rota.
3. **Carteira na ULBRA:** `consultar_operador` fala em "clientes de carteira",
   mas a carteira não é escrita por nenhuma ferramenta. O que o ReATIVA move
   não tem onde ser refletido além do atendimento.

## 5. Indicadores gerenciais: o que contar e o que não contar

Unidades separadas, sem somar uma na outra:

| Unidade | Definição proposta | Fonte |
|---|---|---|
| **Mensagem** | cada mensagem de cliente, bot ou operador | `ler_conversa` — **nunca contada como lead** |
| **Conversa** | uma thread por cliente e canal (WhatsApp ou e-mail) | `listar_conversas` |
| **Atendimento novo** | atendimento aberto no período (um por cliente ativo) | `indicadores_da_equipe` (`resumo`, `kanban`) |
| **Aluno único (lead)** | cliente-pessoa identificado uma vez, por CPF confirmado (`alta_cpf`) ou id de cliente | `conferir_duplicidade` / `ulbra_vinculos_confirmados` |

Regras:
- Resposta de cliente a atendimento já aberto **não** gera lead novo.
- Mesmo aluno com WhatsApp e e-mail conta **uma vez** como aluno único, com
  dois canais.
- O painel de `indicadores_da_equipe` é por equipe e não por aluno; por isso
  o aluno único tem de ser montado no ReATIVA a partir de `conferir_duplicidade`
  e do vínculo CPF, não lido do painel.

## 6. Painel gerencial proposto (somente desenho)

Colunas, por período e por equipe (sem nome de cliente, conforme a
privacidade da integração):

- mensagens recebidas (WhatsApp, e-mail) — volume, não lead
- conversas abertas e encerradas por canal
- atendimentos novos, ofertas, aceitos, expirados (`resumo` da ULBRA)
- alunos únicos novos, com canal de entrada
- transferências feitas, recusadas (`CONTACT_LOCKED`, `TICKET_ATIVO_EXISTENTE`)
- sem responsável há mais de X horas (fila de triagem, fora do alcance)
- divergência de responsável (ReATIVA × ULBRA) — deve ser zero

Dependências: mapeamento de operador (item 4.1), polling com orçamento
(item 2), medição do perfil (item 4.2).

## 7. Matriz de comportamento

| Situação | Comportamento proposto | Preserva |
|---|---|---|
| **Atribuição** nova de aluno no ReATIVA | transferir o atendimento aberto ao operador correspondente; se não houver atendimento, não criar | autoria, carteira |
| **Transferência** de carteira no ReATIVA | mover o atendimento aberto; registrar no histórico do ReATIVA o responsável anterior e o novo | histórico, carteira |
| **Mensagens pendentes** no atendimento | não transferir enquanto houver mensagem sem ler; o operador anterior responde ou o supervisor decide; pendência fica visível no painel | histórico, fidelização |
| **Troca de operador** com atendimento aceito | `transferir_atendimento` com `atendente`; se recusar por `CONTACT_LOCKED`, marcar pendência e não forçar | autoria |
| **Falha** na chamada (timeout, limite, recusa) | não repetir em laço; registrar a tentativa, reconciliar no próximo ciclo pela leitura do atendimento; nenhuma alteração parcial sem registro | integridade |
| **Atendimento em outra equipe** | `CONTACT_LOCKED`: não transferir; registrar equipe dona e só sugerir ao supervisor | carteira de outra equipe |
| **Dois operadores assumindo juntos** | trava pelo atendimento no ReATIVA (uma linha por atendimento ativo) antes de chamar a ULBRA; a segunda chamada volta `sem_mudanca` e não reatribui | duplicidade |
| **Mesmo aluno em dois canais** | um aluno, um responsável, dois canais; não criar segundo lead | unicidade |
| **Fidelização** (10 dias do último acionamento) | transferência não reinicia o prazo; o acionamento anterior segue com quem fez | fidelização |

Proteção contra duplicidade é desenhada em três camadas: a trava no ReATIVA
por atendimento, o `sem_mudanca` da ULBRA e a conferência prévia por
`conferir_duplicidade` antes de qualquer criação. Nenhuma das três foi medida.

## 7b. OAuth de gestão × token de backend

- **Estas 4 leituras** usaram a conexão **OAuth de gestão** (da pessoa), que
  consome o limite diário de 500 da pessoa. Não usaram `ULBRA_MCP_TOKEN`.
- **O token de backend** é o da Edge Function `ulbra-diagnostico` (#854). O
  limite que ele consome **não** foi medido separadamente, e não se sabe se é
  a mesma pessoa da conexão OAuth. Pendente com a TI da ULBRA (#861, §13.6).
- Por isso o saldo medido em 07/11 (restam 443) vale para a pessoa do OAuth,
  não necessariamente para o backend.

## 7c. Mapeamento proposto para conferência (não aplicado)

**Tabela de conferência com e-mails: fora do repositório**, entregue à gestão
do ReATIVA. O repositório não guarda e-mail de operador. Os ids da ULBRA
abaixo são os 13 membros da equipe Reativa, obtidos por `listar_equipes`.

| Nome na ULBRA | ID ULBRA | Candidato no ReATIVA (só por primeiro nome) | Estado |
|---|---|---|---|
| Allan Silva | `698624766387b1cde0c8477a` | Allan (cobranca11) | confirmado |
| Amanda Borges | `691de4c95dbe7b715b9c1a53` | Amanda Borges (cobranca07) | confirmado |
| Amanda Prado Seibel | `691cbe85f6c9e7f8850e09f7` | Amanda (amanda.seibel) | confirmado |
| Diego Cruz | `6a04d0a51bb2511b24611770` | Diego (cobranca13) | confirmado |
| Fernanda Avila | `691dd3255dbe7b715b9645c7` | Fernanda (cobranca04) | confirmado; ULBRA só supervisor |
| João Silva | `6902d3ebb9fba65197979245` | — | sem vínculo (cobranca10 é João Vitor) |
| João Vitor | `691e0e1ecd033c6b374b1036` | João (cobranca10) | confirmado pela gestão |
| Luana Marques | `691ddcd65dbe7b715b998829` | Luana (cobranca05) | confirmado |
| Mauricio Feijo | `691dd3775dbe7b715b9660dc` | Mauricio (cobranca06) | confirmado |
| Nataly Pereira | `691de8195dbe7b715b9d36dd` | Nataly (cobranca08) | confirmado |
| Rafaella Coimbra | `6986289c6387b1cde0ca43c5` | Rafaella (cobranca12) | confirmado |
| Ângela Ferreira | `692700c8e3db35ff4d8562fa` | Angela Ferreira (angela.ferreira) | confirmado; ULBRA só supervisor |
| ㅤMarketing | `6ada61d95c8b95a1e9765229` | — | sem vínculo; sem usuário ReATIVA correspondente |

Os 13 membros estão listados separadamente. Onze vínculos foram confirmados
pela gestão do ReATIVA (inclusive João Vitor ↔ cobranca10). João Silva e
Marketing ficam sem vínculo. Nada foi aplicado no sistema.

**Estado no código (sem uso em runtime):** `src/utils/ulbraOperadores.js`
guarda os 11 vínculos, e `src/utils/ulbraOperadores.test.js` verifica
quantidade, cobertura dos 13 membros, unicidade, formato dos ids e que id
desconhecido não casa por nome (7 testes passando). Nenhuma função de
envio, transferência ou gravação consome esse mapeamento.

**Limites que este mapeamento não resolve:**
- Não substitui o **consentimento OAuth individual** de cada operador. Ação em
  nome do operador exige o consentimento dele.
- Não autoriza enviar mensagem pela **credencial central** (`ULBRA_MCP_TOKEN`).
- Não grava em produção e não executa transferência. O piloto da #861
  permanece restrito à gestão.

Regra: **nenhum vínculo é aplicado por nome.** Os candidatos acima são
inferência por primeiro nome e precisam de confirmação da gestão. João tem
dois candidatos possíveis na ULBRA, e Allan e Fernanda têm nomes parecidos.

Chave de ligação: **e-mail do operador no ReATIVA** → **id do atendente na
ULBRA**. Nome não entra como chave.

| Passo | Quem | Como |
|---|---|---|
| 1. Obter id do atendente | leitura | `listar_equipes` com `equipe` da Reativa (contrato confirmado, sem TI) |
| 2. Tabela de correspondência | gestão ReATIVA | `e-mail ReATIVA` ↔ `id ULBRA` ↔ `nome exibido`, aprovada pela gestão |
| 3. Conferência | sessão principal | cruzar nome e id; rejeitar nome repetido ou par sem confirmação |
| 4. Revalidação | sistema | confirmar o id na hora de cada transferência, nunca só na tabela |

A tabela de correspondência é trabalho da gestão do ReATIVA, não da ULBRA.

## 8. Lacunas (resumo)

1. Documentação da ULBRA desatualizada; a correção está na #854/#861, não aqui (seção 1).
2. Alcance específico dos dados do token de backend: não comprovado (seção 0).
3. Compartilhamento de cota entre backend e OAuth: não comprovado (seção 0, 7b).
4. Webhook ou evento de recebimento: não comprovado (seção 2).
5. Vínculo id ULBRA ↔ e-mail ReATIVA: depende da confirmação da gestão (seção 7c).
5. Carteira não escrita pela ULBRA: sincronização é só de atendimento (seção 4.3).
6. Comportamento real de `transferir_em_lote`, `CONTACT_LOCKED` e concorrência
   não medido com dados reais.
7. Orçamento de chamadas: os limites de 04/11 podem ter mudado; remedir.

## 9. Etapas para aprovação (nenhuma iniciada)

1. **Medição somente leitura:** `meu_acesso`, `listar_equipes`,
   `listar_conversas` (WhatsApp e e-mail) e `indicadores_da_equipe` (`resumo`),
   com registro de limites. Atualiza `mensageria-ulbra.md`. Aprovação: gestão.
2. **Mapeamento de operador:** tabela ReATIVA e-mail ↔ atendente ULBRA,
   revisada pela gestão. Sem transferência.
3. **Indicadores somente leitura:** painel da seção 6, sem gravação. Aprovação: gestão.
4. **Transferência em prévia:** `transferir_em_lote` com `previa: true`
   apenas, lista de conflitos. Aprovação: gestão.
5. **Transferência real controlada:** em lote pequeno, com trava por
   atendimento e registro no histórico, só após os passos 1–4 e autorização
   explícita. Executor único: sessão principal.

Nenhum passo acima altera carteira ou produção sem aprovação específica.

---

## 10. O que a #864 autoriza, e o que NÃO autoriza (08/11/2026)

A autorização M1 da PR **#864** nomeia **uma** migration e trava **um** hash.
Tudo o mais nesta frente segue pendente, com autorização própria a pedir.

| Artefato | Coberto pela #864? | Estado |
| --- | --- | --- |
| `20261108140000_ulbra_recebimento_e_fila` | **SIM** — nome e SHA-256 `ccf3b206…` na linha do registro | **não aplicada** |
| `20261108150000_ulbra_operadores_vinculo` (mapeamento) | **NÃO** — nem nome nem hash constam | preparada, **não aplicada** |
| `20261106190000_ulbra_vinculos_view_confirmados` | **NÃO** | pendente de rodadas anteriores |
| Gravar `ULBRA_SYNC_CHAVE` (ambiente e Vault) | não é migration — passo próprio | não feito |
| Publicar `ulbra-sincronizar` | não é migration — passo próprio | não publicada |
| Criar o cron | **NÃO**, e fora do escopo desta etapa | não criado |

**Três coisas que a linha M1 pendente NÃO significa:**

1. **não significa aplicada** — enquanto a #864 não for mesclada, a linha nem
   existe na `origin/main`, e o hook não tem o que ler;
2. **não significa autorização de outra migration** — ela vincula um hash só.
   A `20261108150000` precisa de linha própria;
3. **não autoriza os passos que não são migration** — secret, deploy e cron
   têm autorização separada, como manda o runbook §6.

Conferido em produção em 08/11/2026 16:44:47Z, somente leitura: versão não
aplicada, 0 tabelas, 0 funções, 0 cron, última versão do banco
`20261107143314`.

### 10.1 O mapeamento, separado de propósito

`20261108150000_ulbra_operadores_vinculo` tem **rollback próprio**
(`…rollback.sql`) e **job próprio no CI** (`ulbra-operadores-sql`, Postgres 17),
que exercita RLS, privilégios e a volta ao estado anterior — mais um passo de
**sensibilidade**: removendo o `revoke all`, a prova TEM de falhar. Se não
falhasse, ela não estaria provando nada contra o
`alter default privileges … grant all on tables to authenticated` do projeto,
que faz tabela nova nascer aberta com TRUNCATE incluso.

O rollback não mexe nesse `alter default privileges`: ele é configuração do
schema, anterior à migration e usada pelo resto do sistema. Desfazê-lo aqui
seria alterar o ambiente inteiro para derrubar uma tabela. A consequência fica
dita: depois do rollback, o ambiente volta ao estado anterior — **e esse estado
inclui a armadilha**.

## 11. Correção da previsão do e-mail (08/11/2026)

O número de 30 minutos que apresentei é **intervalo nominal de consulta, não
prazo máximo garantido**. A espera real pode ser maior por três motivos, todos
já no código:

- **backlog**: o ciclo que atinge o teto de páginas marca `truncado` e deixa o
  resto para o próximo — o excedente espera um ciclo inteiro, ou mais;
- **falha**: erro em `listar_conversas` grava `FALHOU` e **não move a janela**;
  o conteúdo só aparece no ciclo seguinte que der certo;
- **saldo insuficiente**: sem orçamento, o ciclo é pulado (`PULADO_ORCAMENTO`)
  e nada é lido até o dia virar.

Então o correto é: **intervalo nominal de 30 min, sem teto garantido.**

A estimativa de custo abaixo mantém **K = 1**, e esse é o ponto frágil:

| Cadência do e-mail | Chamadas a mais em 12 h | Total 12 h | Acréscimo |
| --- | --- | --- | --- |
| mesmo ciclo (10 min) | +72 | 290 | +83 (+40%) |
| **a cada 30 min** | **+24** | **235** | **+28 (+14%)** |
| a cada 60 min | +12 | 221 | +14 (+7%) |

**O que a tabela não cobre:** ela conta só a **listagem**. Conversa de e-mail
que precise de detalhe disputa a **mesma** capacidade de `ler_conversa` — que
é `DETALHE_POR_CICLO = 1`, um por ciclo, para os dois canais juntos. Ligar o
e-mail sem mexer em K não aumenta a capacidade de detalhe: **aumenta a fila que
divide a mesma capacidade**, e a condição de convergência λ × P < K passa a
valer para a soma dos canais. Se a coleta mostrar λ perto de 1 só com WhatsApp,
somar e-mail empurra a fila para a não convergência — e a saída, pela regra já
registrada, é encurtar o intervalo do ciclo de detalhe, não subir K.

Por isso o e-mail fica no escopo final **sem ativação nesta etapa**: a decisão
depende do λ medido, e medir λ só com WhatsApp não responde pelo conjunto.

---

## 12. Painel Gestão da Mensageria — primeira entrega (09/11/2026)

Aprovado visualmente pela demonstração de 08/11. Implementado sobre o que já existe:
o espelho do piloto (`ulbra_conversas`, `ulbra_atendimentos`, `ulbra_sync_estado`,
`ulbra_leitura_usuario`) e os helpers de `ulbraRecebimento.js`. **Nenhuma chamada à
ULBRA**: a tela lê só o Postgres, por uma RPC de agregação. Abrir dez painéis custa zero.

### 12.1 Migration separada — `20261109090000_ulbra_painel_gestao` (NÃO aplicada)

Uma função, `public.ulbra_painel_gestao() -> jsonb`, `security definer` com `search_path`
fixo, `revoke` de `public`/`anon`, `execute` para `authenticated` com **portão interno**
`usuario_e_gestao()` — quem não é gestão recebe `ACESSO_NEGADO` e nenhum número. Agrega no
banco (`count`, `group by`, `percentile_cont`) sobre o espelho **inteiro**: não herda o teto
de 200 linhas do sino. Devolve só contagens, datas e e-mails de operador; nenhum nome,
prévia ou id de cliente (provado no teste). Rollback: `drop function`, sem `cascade`.

**Não está coberta por nenhuma linha M1.** Precisa de linha própria para ser aplicada.
Até lá, a tela mostra "Painel não disponível" — sem número no lugar.

### 12.2 O que a tela mostra, na ordem

1. **Confiabilidade antes dos números:** último ciclo, atraso, resultado (`ultimo_ciclo` +
   `ultimo_erro`), chamadas do dia, backlog (fila de detalhes), pendências, cursor e saldo
   da pessoa do token **como fotografia com hora** — nunca como saldo final.
2. **Indicadores:** sem responsável; conversas com resposta do aluno aguardando (última
   mensagem é do cliente); **não lidas por você** (marcador é por pessoa — a mesma regra do
   sino); coletados; em conferência; sem operador; identidade confirmada; total.
3. **Espera:** começa em **`entrou_em`** — a entrada em espera *na Mensageria*, informada
   pela ULBRA — **não** na hora da coleta. Atendimento sem `entrou_em` sai da conta e é
   contado em `sem_data`. Resposta de aluno: desde `ultima_mensagem_cliente_em`.
4. **Canal e situação:** conversas por canal e situação; atendimentos por situação;
   **atendimentos por canal = não disponível** (o espelho não guarda canal). Distribuição
   por responsável **só por posse comprovada** (`responsavel_email`); o destino sugerido sai
   à parte, rotulado como sugestão. **Divergência carteira × responsável ULBRA = não
   disponível**: depende do mapeamento `20261108150000`; não se calcula por nome.
5. **Cobertura:** equipe, canais coletados, canais ativos (WhatsApp; **e-mail não ativo**),
   situações, período coletado, primeira/última coleta, alcance em páginas (**não
   disponível** até existir coluna). "O que foi coletado, não o total da Mensageria."

### 12.3 Estados — cinco, e diferentes

| estado | quando | o que a tela diz |
| --- | --- | --- |
| `SEM_CICLO` | `ultima_execucao` nula | os zeros são porque nada foi coletado |
| `ERRO` | `ultimo_ciclo = FALHOU` | erro, janela não avançou, números são do último ciclo bom |
| `DESATUALIZADO` | **só com cron ativo** e atraso > 25 min | zero aqui não significa nada |
| `INCOMPLETO` | `ultimo_ciclo = INCOMPLETO` | cursor não avançou, piso guardado, nada descartado |
| `EM_DIA` | o resto | zero é zero de verdade |

**Sem cron**, a tela diz **"atualização manual — sem sincronização automática ativa"**, e
atraso grande **não** vira `DESATUALIZADO` (é informação, não defeito). A função lê
`cron.job` para decidir; sem `pg_cron` legível, responde `desconhecida` — nunca inventa
"automática".

### 12.4 Provas

- `supabase/tests/ulbra_painel.test.js` (PGlite) e job `ulbra-painel-sql` (Postgres 17):
  privilégios; operador e inativo recebem `ACESSO_NEGADO` sem agregados; agregados sobre o
  seed do recebimento (3 conversas, 4 atendimentos); `por_responsavel` vazio com sugestões
  presentes; canal de atendimento e divergência = `null`; base da espera declarada;
  cobertura; **nenhum nome/id de cliente na resposta**; leitura por usuário muda só o
  "para mim"; transições `SEM_CICLO → INCOMPLETO → ERRO → EM_DIA` com 3 h de atraso sem
  cron; rollback deixa o piloto de pé.
- `src/pages/PainelMensageriaUlbra.test.jsx` (13): nenhum `fetch`; confiabilidade antes dos
  números; fotografia do saldo; "não disponível" nos três lugares; "atualização manual";
  base da espera; cobertura com e-mail não ativo; posse × sugestão; estados; recusa a
  não-gestão; função ausente; erro com "tentar de novo"; `fmtMin`.

### 12.5 Próxima rodada

Adaptar a **central do operador** sobre esta mesma base (mesma RPC, recorte por pessoa).
Fora: cron, e-mail, mapeamento, acesso dos operadores.
