# Diagnóstico — titularidade, filas e calibragem (24/09/2026)

**Etapa de leitura. Nada foi alterado em produção.** Todos os números vêm de
`SELECT` no projeto de produção (`ahattpqrjmhkzsmnbdzs`) em 24/09/2026.

---

## 1. Onde mora a titularidade

Não existe uma tabela de titularidade. Ela está espalhada por **três fontes que
podem divergir entre si**, mais o histórico:

| Fonte | Coluna | Papel |
|---|---|---|
| `casos` | `operador_email`, `operador_nome`, `operador` | quem trabalha o caso na fila |
| `alunos` | `responsavel_atual_email`, `_nome`, `_em` | quem é o dono da ficha |
| `acordos` | `operador_responsavel_email`, `_nome` | quem responde pelo acordo |
| `usuarios` | `perfil`, `ativo`, `pode_alterar_responsavel` | quem é operador e quem pode trocar dono |

`casos` ainda guarda quatro colunas herdadas de titularidade —
`operador_base`, `operador_mensalidade`, `operador_acordo`,
`operador_acordo_planilha` — e uma `fila_responsavel`. Nenhuma governa a fila
hoje; quem manda é `operador_email`.

### As três fontes se mantêm sincronizadas por gatilho

- `alunos → casos`: `trg_sync_casos_resp_aluno` (`_sync_casos_resp_aluno`)
- `casos → alunos`: `trg_sync_alunos_apos_casos` (`trg_sincronizar_alunos_apos_casos`)
- `acordos → alunos`: `trg_aluno_segue_dono_do_acordo` (`_aluno_segue_dono_do_acordo`)
  — **realinha a ficha ao dono do acordo ATIVO quando o aluno não tem
  mensalidade em aberto e o dono do acordo é operador ativo.**
- `alunos → acordos` (só no insert): `trg_acordo_herda_responsavel`

**Consequência que define o desenho desta entrega:** mover o caso e deixar o
acordo com o dono antigo faz o aluno voltar para o dono antigo.

### Escrita é protegida

`UPDATE` direto em responsável é barrado por `_guard_resp_aluno` e
`_guard_resp_acordo`. As únicas portas são `internal.set_resp_aluno` e
`internal.set_resp_acordo`, que pertencem ao papel
`reativa_responsavel_executor` e por isso atravessam as travas. Toda RPC de
titularidade passa por elas.

### Divergências medidas hoje

| Situação | Casos |
|---|---:|
| `casos.operador_email` ≠ `alunos.responsavel_atual_email` | **23** |
| Ficha diz Olga e o caso é de outro (todos "sem operador") | **5** |
| Ficha diz Olga e não existe caso | **8** |
| Acordo vivo da Olga em caso de outro operador | **83** |

---

## 2. Quem pode trocar responsável hoje

| Porta | Quem passa |
|---|---|
| `internal.pode_alterar_responsavel()` | `usuarios.pode_alterar_responsavel AND ativo` → **só Amanda gestora e Fernanda** |
| `vincular_responsavel_caso()` | allowlist fixa: **Amanda gestora e Fernanda** |
| `public.calibragem_e_gestao()` | **Amanda gestora, Fernanda e Amanda ADM** |
| `internal.nome_operador_ativo()` | destino precisa ser `perfil='operador'` ou um dos três e-mails da gestão |

**Achado importante:** a Amanda ADM (`cobranca07`) tem
`pode_alterar_responsavel = false`. Ela vê o controle de troca de responsável na
ficha (o front usa `podeVerTudo`, que a inclui), mas a RPC recusa com
`SEM_PERMISSAO`. A Carteira Geral **não depende desse flag**: ela usa
`calibragem_e_gestao()`, que já inclui os três logins pedidos. Nenhum dado de
permissão precisa ser alterado.

### `alterar_responsavel_aluno` tem compensação embutida

Ao tirar um caso de A e dar para B, a função **procura um caso equivalente de B
e devolve para A**, para não desequilibrar as carteiras. É a regra certa para
uma troca pontual na ficha e a **regra errada para recolher uma carteira
inteira**: recolher os 735 casos da Olga devolveria até 735 casos de outros
operadores *para a Olga*. Por isso a Carteira Geral tem RPC própria, sem
compensação.

---

## 3. A "fila livre" hoje é o mesmo que "sem dono"

Não existe marcação de fila livre. A fila livre **é** `casos.operador_email IS NULL`
(e `alunos.responsavel_atual_email IS NULL`, em `fila_casos_sem_responsavel`).

Isso significa que o mesmo `NULL` alimenta, ao mesmo tempo:

| Consumidor | Como pesca | Estado |
|---|---|---|
| `assumir_caso_livre` / `assumir_caso_livre_aluno` | operador se serve sozinho, `operador_email is null` | ativo (tela do operador) |
| `reposicao_carteira_processar` | repõe até 500 ao fechar caso | **cron pausado** (job 43 inativo) |
| `nivelar_medias_progressivo` | troca com o pool | fora do cron (`job_nivelamento_diario` não está agendado) |
| `reforcar_teto_operadores` | solta o excedente para o pool | idem |
| `calibragem_simular/executar_nivelamento` | puxa do pool | tela da gestão |
| `nivelamento_automatico_gestao` | distribui a base da gestão | **cron ATIVO, 09:20 todo dia** (job 48) |

**Conclusão:** "tirar da Olga" mandando para `NULL` devolve tudo à operação no
minuto seguinte — inclusive para a própria Olga.

### Única reserva que já existia

`reposicao_carteira_processar` exclui `caso_reservado_administrativo(chave_unificacao)`,
que é "o aluno está com a Amanda ADM em `alunos_unificados`". É a única
exceção, e ela **não é respeitada** por `nivelar_medias_progressivo`, por
`reforcar_teto_operadores` nem pelo `assumir_caso_livre`.

### Defeitos encontrados de passagem

1. `reforcar_teto_operadores` e `nivelar_medias_progressivo` agrupam por
   **qualquer** `operador_email` não nulo (exceto Amanda gestora). Isso inclui
   `juridico@` — 58 casos, saldo zero — que puxa a média da equipe para baixo.
2. `public.nome_operador_por_email()` troca dois nomes:
   `cobranca12 → 'DIEGO'` e `cobranca13 → 'RAFAELLA'`. O correto (em `usuarios`,
   no front e no mapa de `trg_sincronizar_alunos_apos_casos`) é
   `cobranca12 = RAFAELLA` e `cobranca13 = DIEGO`. Essa função carimba
   `operador_nome` em `assumir_caso_livre_aluno`.
3. `AlterarOperadorResponsavel.jsx` tem um `if (false)` onde estava a validação
   de motivo obrigatório — a validação está desligada.

Os três estão **fora** desta entrega (o item 1 é corrigido de lado, ver §6).

---

## 4. Como funcionam as Ações Massivas hoje

Padrão de três tempos, que a Carteira Geral reaproveita:

1. **Prévia** — `acoes_massivas_previa(...)` calcula candidatos, grava em
   `acoes_massivas_previas` (filtros, universo, elegíveis, motivos de exclusão)
   e devolve um `previa_id`.
2. **Execução** — `acoes_massivas_exportar(..., p_previa_id)` age **sobre aquela
   prévia** e grava o lote em `acoes_massivas_lotes` (aluno_ids, total,
   exportado_por, filtros, resumo de exclusões).
3. **Conclusão** — `acoes_massivas_concluir_lote(p_lote_id, p_acao)` confirma ou
   descarta.

Auditoria de titularidade já existente, que continua sendo alimentada:
`historico_operadores_alunos`, `aluno_movimentacoes`, `calibragem_auditoria`.

---

## 5. Fotografia da carteira (24/09/2026)

Saldo pela fonte viva (`calibragem_saldo_aluno`: títulos ABERTO/em_aberto sem
acordo e sem vínculo ativo + parcelas vivas de acordo não cancelado). Casos
encerrados operacionalmente fora.

| Responsável | Perfil | Casos | Vivos | Com saldo | Total | Mensalidade | Acordo |
|---|---|---:|---:|---:|---:|---:|---:|
| **(sem operador)** | — | 12.696 | 8.829 | 8.736 | **R$ 20.918.834,28** | 20.865.626,11 | 53.208,17 |
| Allan | operador | 864 | 683 | 656 | 2.759.370,35 | 1.600.572,02 | 1.158.798,33 |
| João | operador | 849 | 666 | 638 | 2.861.229,79 | 1.695.000,81 | 1.166.228,98 |
| Nataly | operador | 739 | 538 | 501 | 2.771.606,68 | 1.414.642,74 | 1.356.963,94 |
| **Olga** | operador | **735** | **564** | **545** | **2.546.943,15** | 819.405,33 | 1.727.537,82 |
| Rafaella | operador | 649 | 495 | 469 | 2.474.672,62 | 1.168.683,16 | 1.305.989,46 |
| Luana | operador | 633 | 464 | 434 | 2.745.806,33 | 984.913,69 | 1.760.892,64 |
| Mauricio | operador | 588 | 393 | 376 | 2.461.641,73 | 1.068.094,73 | 1.393.547,00 |
| Diego | operador | 550 | 414 | 398 | 2.499.348,39 | 1.329.613,38 | 1.169.735,01 |
| Jurídico | juridico | 58 | 0 | 0 | 0,00 | 0,00 | 0,00 |
| Amanda gestora | gerencia | 36 | 13 | 13 | 28.231,87 | 0,00 | 28.231,87 |
| Amanda ADM | administrativo | 25 | 24 | 24 | 214.796,18 | 73.458,80 | 141.337,38 |
| Fernanda | supervisor | 2 | 2 | 1 | 136.336,54 | 67.042,89 | 69.293,65 |

**Casos sem operador são 47% do dinheiro em aberto.** Hoje qualquer operador
pode se servir deles sozinho.

**Não existe operador inativo em `usuarios` hoje** — os 13 usuários estão
`ativo = true`. O equivalente real de "responsável que não é da fila" são os
121 casos com Jurídico, gerência, ADM e supervisão. O painel trata os três
casos (inativo, e-mail fora do cadastro, perfil que não é operador) sob o mesmo
alerta, porque na prática significam a mesma coisa: ninguém da fila está
trabalhando aquele aluno.

### Atenção: não use as colunas de saldo de `casos`

`casos` tem quatro colunas de saldo e elas não batem:

| Coluna | Linhas preenchidas (de 18.424) | Soma |
|---|---:|---:|
| `total_em_aberto` | 12.725 | R$ 27.267.175,81 |
| `saldo_total` | 13.375 | R$ 44.511.237,85 |
| `mensalidades_em_aberto` | **250** | R$ 4.951.117,42 |
| `acordo_em_aberto` | **574** | R$ 3.154.333,36 |

As duas que teriam o recorte por tipo de dívida estão abandonadas. O painel
**não** as usa.

---

## 6. Decisões técnicas

### D1 — Carteira Geral é um titular, não um `NULL`

Destino reservado `carteira.geral@reativa.local`, linha em `usuarios` com
`perfil = 'carteira'` e `ativo = false`.

- **Não é login.** Não existe em `auth.users`, não tem senha. Mesmo padrão de
  `painel.tv@reativa.local`. Quem opera entra com o próprio e-mail.
- `ativo = false` a mantém fora de todo seletor de pessoa da operação (todos
  filtram `.eq("ativo", true)`); `public.nome_do_operador()` não filtra `ativo`,
  então o rótulo continua resolvendo em telas e gatilhos.
- Como **todas** as rotinas automáticas pescam em `operador_email IS NULL`, um
  titular explícito fica fora de todas elas **por construção** — sem remendar
  consulta por consulta.
- Pelo mesmo motivo, "fila livre" continua sendo exatamente o que sempre foi
  (`NULL`), e o requisito *"operadores só assumem o que está explicitamente na
  fila livre"* passa a valer sem mudar o `assumir_caso_livre`.
- `perfil ≠ 'operador'` também desarma, sozinho, `trg_impor_teto_operador`,
  `trg_repor_caso_operador` e `_aluno_segue_dono_do_acordo`, que testam o perfil.

### D2 — RPC própria, sem compensação

`carteira_geral_mover` não replica a compensação de `alterar_responsavel_aluno`
(ver §2). Escreve pelo caminho oficial (`internal.set_resp_*`), sem GUC de
bypass e sem `UPDATE` direto em responsável.

### D3 — Prévia congelada, execução por `previa_id`

A execução **não refaz a consulta**: lê a lista gravada em
`carteira_geral_previas.itens`. Item cujo dono mudou entre a prévia e o clique é
**recusado** e volta no resultado. Mesmo contrato das Ações Massivas.

### D4 — Interruptor de entrada de casos novos

Coluna nova `usuarios.recebe_novos_casos` (default `true`), lida por
`internal.operador_pode_receber_caso()` — uma porta só, para não existirem
versões diferentes da regra espalhadas. Ela reusa `internal.nome_operador_ativo`
(que já exige `ativo` e perfil) e soma o flag; ver D13.

Desligada, fecha as **duas** portas de entrada:

1. distribuição automática (nivelamento das 09:20, reposição, calibragem);
2. auto-atribuição da fila livre (`assumir_caso_livre`, `assumir_caso_livre_aluno`,
   `sistema_assumir_atendimento`, `assumir_atendimento_aluno`).

A segunda é a mais larga: nenhuma distribuição precisa acontecer para a carteira
voltar — basta a própria pessoa clicar em "assumir".

O que **não** faz: não desativa o operador, não tira o que já é dele e não
impede a gestão de atribuir manualmente. `sistema_assumir_receptivo` fica de
fora de propósito: ali o aluno está no telefone.

### D5 — Patch ancorado, não reescrita

As funções automáticas não foram reescritas à mão. A migration de blindagem lê
a definição viva (`pg_get_functiondef`), exige a âncora na contagem exata e
troca só aquele trecho — preservando o resto byte a byte. Se a âncora não
bater, **a migration falha**, não aplica pela metade. O repositório tem drift
conhecido entre migrations e banco (`docs/RUNBOOK-MIGRATIONS.md`); retypar 200
linhas com regex e escape seria a forma mais fácil de introduzir bug silencioso.

### D6 — Acordo do dono vai junto; acordo de TERCEIRO, só escolhido um a um

Dois grupos, duas regras:

- **Acordo cujo responsável é o dono do caso** → vai junto (opção ligada por
  padrão). Deixá-lo para trás faz `_aluno_segue_dono_do_acordo` devolver o aluno
  ao dono antigo quando não há mensalidade em aberto.
- **Acordo de terceiro** → **fica**, a menos que o id esteja em `p_acordo_ids`.
  Cada um aparece na prévia numa linha própria, com número, valor, status e de
  quem é.

Um acordo de terceiro é trabalho de negociação de alguém que não está sendo
remanejado. Levar 159 deles embutidos num lote de 545 alunos seria mover a
custódia de nove pessoas sem que ninguém olhasse um por um. **Não existe forma
de mover acordo de terceiro sem citar o id dele.**

Consequência medida de deixá-los: o gatilho realinha **2** dos 545 alunos ao
dono do acordo. Nos outros há mensalidade em aberto e ele não age.

**Isso não reescreve autoria.** Muda `acordos.operador_responsavel_email`
(custódia). Não toca em `criado_por_email`, `confirmado_por_email`,
`pagamentos.operador_email` (que define honorário e comissão), baixas,
parcelas, títulos, valores nem no histórico já gravado.

### D7 — Ano é ano de vencimento

Não existe "ano do aluno". O painel agrega por ano de vencimento de cada dívida:
o **valor** por ano soma o total; a **contagem de alunos** não, porque quem deve
em dois anos conta nos dois. A tela diz isso em texto.
(`alunos.semestre_divida` é `venc_max` e não serve para corte por período —
`docs/DIAGNOSTICO-ESTRUTURAL-2026-09-23.md`.)

### D8 — Desfazer por reconstrução, sem atropelar trabalho posterior

Este projeto **não tem PITR**. `carteira_geral_desfazer_lote` devolve cada
aluno/acordo ao e-mail registrado na auditoria, por id exato.

E entre o lote e o desfazer a operação continuou trabalhando: alguém pode ter
assumido o caso da fila livre, a gestão pode ter movido de novo, um acordo pode
ter sido quitado. Cada item só volta se **tudo** ainda estiver como o lote
deixou — `casos.operador_email`, `alunos.responsavel_atual_email` e, para cada
acordo movido, responsável **e** status. Qualquer divergência **recusa o aluno
inteiro** (não desfaz pela metade) e volta no resultado com o motivo; a linha da
auditoria fica sem marca de desfeito, e o lote aparece como parcialmente vivo.

A auditoria é append-only: só `desfeito_em`/`desfeito_por_email` mudam.

### D9 — O retorno agendado sobrevive à troca de custódia

`internal.set_resp_aluno` zera `data_retorno`, `hora_retorno` e `proxima_acao`
em toda troca de dono; por tabela, `limpar_retorno_origem` apaga
`retorno_origem` e `tg_aluno_reset_retorno_confirmado` apaga
`retorno_confirmado_em`. Faz sentido quando o caso vai para outra pessoa começar
do zero — **não** faz quando é a gestão recolhendo uma carteira: um retorno
agendado é compromisso assumido com o aluno.

`internal.set_resp_aluno` **não foi alterada** (17 funções escrevem por ela).
`internal.carteira_geral_trocar_dono` lê o agendamento antes, devolve depois e
reaponta `operador_agenda` para o novo responsável, mantendo `retorno_em`.
Vale na ida e na volta do desfazer.

`data_ultimo_acionamento` e `status_acionamento` já estavam protegidos pelo
gatilho `_acionamento_nao_volta_para_nulo` — o teste cobre isso para o caso de
alguém mexer nele.

**Exceção, na fila livre:** ali não há novo responsável. O compromisso continua
no aluno (data, hora e origem), e quem assumir depois o herda — mas a linha de
`operador_agenda` é encerrada com `CANCELADO_LIBERACAO`, o mesmo marcador que
`assumir_caso_livre_aluno` já usa. Manter o compromisso na agenda de quem perdeu
o caso seria pior do que encerrá-lo.

### D10 — A execução não decide nada

`carteira_geral_mover` perdeu o parâmetro `p_mover_acordos`: quem decide é a
prévia, acordo por acordo, e a execução só honra o plano congelado. A assinatura
antiga foi removida (`drop function`) — deixá-la viva permitiria mover acordo de
terceiro sem ninguém ter olhado.

Antes de tocar em qualquer linha, a execução **revalida**: o dono do caso e da
ficha, e de cada acordo marcado o responsável **e** o status. Um acordo que
virou QUITADO ou CANCELADO depois da prévia não é mais o mesmo objeto e não
viaja em silêncio — é recusado, e o aluno segue.


### D11 — O gatilho do acordo não desfaz a decisão da gestão

`_aluno_segue_dono_do_acordo` realinha a ficha ao dono do acordo ATIVO quando o
aluno não tem mensalidade em aberto. Depois de um recolhimento isso é um
contra-sentido: os acordos de terceiros ficam com terceiros **de propósito**, e
no dia em que um deles mudar de status ou de dono o gatilho puxaria o aluno para
fora da Carteira Geral sozinho.

Medido em 24/09/2026: atinge **2 dos 545** alunos da Olga — Cainã Costa
Demeneghi (acordo 3071, da Rafaella) e Leônidas Araújo de Mesquita Melo (acordo
1271, do Allan). Nos outros 143 com acordo de terceiro há mensalidade em aberto
e o gatilho não age.

O gatilho passa a sair cedo quando o aluno está na Carteira Geral. A trava é
específica: para qualquer outro aluno ele continua agindo como sempre, e o teste
prova os dois lados.

### D12 — A fidelização não esvazia a Carteira Geral

`casos_elegiveis_liberacao_fidelizacao` pega **todo** caso com dono não nulo, sem
olhar perfil, e o cron das 08:20 (job 8, **ativo**) solta o que passou de 10 dias
sem acionamento. A Carteira Geral tem dono não nulo e, por definição, ninguém a
aciona: **no 11º dia ela inteira cairia na fila livre.**

Era o vazamento mais perigoso do desenho, e não aparecia em nenhuma das rotinas
que eu havia mapeado, porque ela não "distribui" — ela solta.

### D13 — Desligar alguém é `usuarios.ativo = false`, e isso não bastava

O interruptor de verdade para quem sai da equipe já existe: `usuarios.ativo`.
O problema é que ele **não era respeitado** nas portas de auto-atribuição:
`assumir_caso_livre`, `assumir_caso_livre_aluno` e `assumir_atendimento_aluno`
se protegem com `if public.nome_operador_por_email(v_email) is null`, e essa
função **nunca devolve null** — cai em `upper(split_part(email,'@',1))` para
qualquer e-mail. Guarda morta: uma pessoa desligada, com sessão válida,
conseguia assumir da fila livre.

`internal.operador_pode_receber_caso()` reusa `internal.nome_operador_ativo`
(que já exige `ativo` e perfil) e soma o flag `recebe_novos_casos`. Passou a
valer nas cinco portas de auto-atribuição, no rodízio do receptivo e nas três
rotinas automáticas.

**O receptivo não é autorização para reassumir.** `sistema_assumir_receptivo`
grava o operador direto em `alunos` e chama `set_resp_aluno`: quem atende leva o
caso. Agora quem não pode receber caso atende mas não leva, e **ninguém** tira
aluno da Carteira Geral por telefone — nem operador ativo. O resto do fluxo
receptivo não mudou.

### D14 — `auth.users` fica FORA deste PR

`usuarios.ativo = false` tira as permissões dentro do CRM, mas **não impede o
login**. Em 24/09/2026 a conta da Olga em `auth.users` está viva: não banida,
não apagada, último acesso em 11/09/2026.

`auth.users` é gerido pelo Supabase Auth e escrita direta por migration não é
suportada — pode quebrar o serviço. Banir a conta e revogar as sessões é ação
administrativa no painel (Authentication → Users) ou pela Admin API.

---

## 7. O que ficou de fora

- **Não foi aplicada nenhuma migration em produção.** Os quatro arquivos estão
  no PR e devem ser aplicados por `apply_migration`, conforme o runbook.
- **Nenhum remanejamento foi executado.** A simulação da Olga é leitura.
- `pode_alterar_responsavel` da Amanda ADM continua `false` — a Carteira Geral
  não depende dele. Mudar isso é decisão à parte.
- Os três defeitos do §3 (nomes trocados em `nome_operador_por_email`,
  `if (false)` em `AlterarOperadorResponsavel.jsx`) não foram tocados.
- Banir a conta em `auth.users` e revogar as sessões (ver D14).
- `whatsapp_assumir_conversa` e `assumir_link_pagamento` não foram bloqueados:
  são atendimento e fila administrativa, não custódia de caso — nenhum dos dois
  muda `casos.operador_email` nem `alunos.responsavel_atual_email`.
- Os 8 alunos cuja ficha aponta para a Olga **sem caso** não aparecem na
  Carteira Geral (a tela parte de `casos`). É correção de cadastro.
- Os 83 acordos da Olga que vivem em casos de **outros** operadores não entram
  no lote dela: mover o acordo exigiria mover o caso do outro operador.
