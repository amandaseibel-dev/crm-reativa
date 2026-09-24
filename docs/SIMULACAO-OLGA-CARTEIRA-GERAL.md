# Simulação — recolher a carteira da Olga (24/09/2026)

**NADA FOI EXECUTADO.** Isto é leitura de produção replicando a lógica de
`carteira_geral_previa`. Nenhuma linha de titularidade foi alterada, nenhuma
migration foi aplicada.

Operadora: **Olga — `cobranca03@aelbra.com.br`**. **Ela não faz mais parte da
equipe.** Em 24/09/2026 o cadastro ainda está `perfil = operador`, `ativo = true`,
e o login em `auth.users` continua **vivo** (não banido, não apagado, último
acesso em 11/09/2026) — ver §7.

> **Os números se mexem.** A base é viva: entre duas leituras com poucas horas de
> diferença, a contagem de acordos de terceiros passou de 155 para 159. A fonte
> de verdade na hora de decidir é a **prévia na tela**, não esta página.

---

## 1. O que está sob a responsabilidade dela

Titularidade lida nas três fontes, separadamente, porque elas divergem.

| Fonte | Quantidade |
|---|---:|
| Casos (`casos.operador_email`) | **735** |
| — dos quais vivos (não encerrados) | 564 |
| — dos quais vivos **e com saldo** | **545** |
| Fichas de aluno (`alunos.responsavel_atual_email`) | **721** |
| Acordos (`acordos.operador_responsavel_email`) | **356** |
| — com status ATIVO | 260 |
| Parcelas nesses acordos | 1.550 |
| — parcelas vivas | **1.012** |
| Mensalidades em aberto nos casos dela | **1.210** títulos, em 329 alunos |
| Casos com retorno agendado | **552** |
| Fichas com retorno agendado | 532 |
| Termos em nome dela | 152 |
| Links de pagamento em nome dela | 179 |
| Linhas na tabela `retornos` (receptivo) | **0** |

> `retornos` é a fila do receptivo e não tem nada da Olga. O "retorno ativo" que
> importa aqui é o agendamento em `alunos.data_retorno` / `hora_retorno` — que é
> o que a fila do operador lê — e o espelho em `casos.data_retorno`.

**Dinheiro sob responsabilidade dela** (fonte `calibragem_saldo_aluno`):

| Recorte | Alunos | Total | Mensalidade | Acordo |
|---|---:|---:|---:|---:|
| Vivos e com saldo | 545 | **R$ 2.546.943,15** | 819.405,33 | 1.727.537,82 |
| Tudo, inclusive encerrado e saldo zero | 735 | R$ 2.933.642,29 | 943.389,71 | 1.990.252,58 |

---

## 2. Titularidades divergentes

| Divergência | Qtd. |
|---|---:|
| Acordo vivo **dela** em caso de **outro** operador | **83** |
| Ficha diz Olga e o caso é de outro (os 5 casos estão **sem operador**) | **5** |
| Ficha diz Olga e **não existe caso** | **8** |
| Acordos vivos em casos dela que pertencem a **outro** responsável | **159**, em 145 alunos |
| `casos.operador_email` ≠ `alunos.responsavel_atual_email` dentro dos 735 | **0** |

---

## 3. Cenário recomendado — recolher para a Carteira Geral

Filtro: responsável = Olga, com saldo, sem encerrados. Destino: **Carteira Geral**.
"Levar os acordos do próprio dono": **marcada**. Acordos de terceiros:
**nenhum selecionado** (o padrão).

### O que vai

| | |
|---|---:|
| Alunos movidos | **545** |
| Valor total | **R$ 2.546.943,15** |
| — mensalidade | R$ 819.405,33 |
| — acordo | R$ 1.727.537,82 |
| Acordos **da Olga** que vão junto | **227** |
| Acordos **de terceiros** que ficam | **159** (R$ 651.637,17, em 145 alunos) |
| Retornos agendados **preservados** | **519** |
| Mensalidades em aberto envolvidas | 1.107 títulos |

### Por ano de vencimento

| Ano | Tipo | Alunos | Itens | Valor |
|---:|---|---:|---:|---:|
| 2027 | Acordo | 91 | 136 | R$ 240.045,90 |
| 2026 | Acordo | 281 | 1.007 | R$ 1.429.151,65 |
| 2026 | Mensalidade | 250 | 646 | R$ 592.523,72 |
| 2025 | Acordo | 31 | 92 | R$ 58.340,27 |
| 2025 | Mensalidade | 104 | 420 | R$ 184.999,16 |
| 2024 | Mensalidade | 12 | 41 | R$ 41.882,45 |

Soma dos valores = R$ 2.546.943,15. **A soma de alunos por ano não fecha com
545** — quem deve em 2025 e 2026 aparece nos dois.

### O retorno agendado não se perde

Os **519 retornos** viajam com o aluno: **data, hora e origem preservadas**, e a
agenda passa a responder ao novo responsável.

Isso exigiu código: `internal.set_resp_aluno` zera o agendamento em toda troca
de dono, e por tabela `limpar_retorno_origem` apaga a origem e
`tg_aluno_reset_retorno_confirmado` apaga a confirmação.
`internal.carteira_geral_trocar_dono` lê tudo antes, devolve depois e reaponta
`operador_agenda`. `data_ultimo_acionamento` e `status_acionamento` já estavam
protegidos pelo gatilho `_acionamento_nao_volta_para_nulo`.

### Os 2 alunos que o gatilho puxaria de volta — identificados

São os únicos do lote cuja dívida inteira é um acordo de outra pessoa, **sem
mensalidade em aberto**. Nessa combinação, `_aluno_segue_dono_do_acordo`
realinha a ficha ao dono do acordo assim que aquele acordo mudar de status ou de
responsável — tirando o aluno da Carteira Geral sozinho, sem ninguém pedir.

| Aluno | Saldo | Acordo | Status | Responsável do acordo |
|---|---:|---:|---|---|
| Cainã Costa Demeneghi | R$ 463,43 | 3071 | ATIVO | Rafaella (`cobranca12`) |
| Leônidas Araújo de Mesquita Melo | R$ 441,73 | 1271 | ATIVO | Allan (`cobranca11`) |

**Corrigido:** o gatilho passa a não mexer em aluno que está na Carteira Geral.
Custódia da gestão não é acidente a corrigir. A trava é específica — para
qualquer outro aluno o gatilho continua agindo como sempre, e há teste provando
os dois lados.

Depois do recolhimento, esses 2 ficam com **caso, ficha e acordos exatamente
como a prévia previu**: caso e ficha na Carteira Geral, acordo com Rafaella e
com Allan. Nada de autoria ou de valor muda.

### Os 159 acordos de terceiros: decisão item a item

Eles **não vão junto**. Cada um aparece na prévia numa linha própria, com
número, valor, status e de quem é, e só se move se você marcar.

Deixá-los **não** arrasta mais o aluno junto: o gatilho
`_aluno_segue_dono_do_acordo` passou a não mexer em quem está na Carteira Geral
(ver o bloco acima). Os 159 ficam com quem os negociou, e os 545 alunos
continuam onde a prévia disse que ficariam.

### Conflitos que a prévia exibirá

| Aviso | Casos |
|---|---:|
| Acordo de terceiro que FICA | **159** (um por linha, selecionável) |
| Retorno agendado que segue com o aluno | **519** |
| Titularidade divergente entre caso e ficha | 0 |
| Caso já encerrado | 0 |

### O que muda

- `casos.operador_email` → `carteira.geral@reativa.local`
- `alunos.responsavel_atual_email` → idem
- `acordos.operador_responsavel_email` dos **227** acordos da Olga → idem
- `operador_agenda.operador_email` dos agendamentos abertos → idem

### O que **não** muda

- Quem criou e quem confirmou cada acordo
- `pagamentos.operador_email` — **o honorário e a comissão da Olga por tudo que
  ela já recebeu continuam dela**
- Baixas, parcelas, títulos, valores, status financeiro
- Os 159 acordos de terceiros
- Data, hora e origem dos 519 retornos agendados
- `historico_operadores_alunos` e `aluno_movimentacoes` já gravados

### Resultado esperado

- Olga fica com **190 casos** (735 − 545): os encerrados e os de saldo zero.
- Carteira Geral: 545 alunos / R$ 2.546.943,15.
- Nenhuma rotina automática pega esses 545 — elas só pescam em
  `operador_email IS NULL`, e a Carteira Geral não é nulo.
- Nenhum operador consegue assumi-los pela tela dele, pelo mesmo motivo.
- Para liberar à operação: selecionar e mandar para **fila livre**, no ritmo que
  você quiser.

---

## 4. Cenário alternativo — recolher literalmente tudo

Desmarcando "apenas com saldo" e marcando "incluir encerrados".

| | |
|---|---:|
| Alunos movidos | **735** |
| Valor total | R$ 2.933.642,29 |
| Retornos preservados | **552** |
| Conflito adicional | 171 casos encerrados (mover não os reabre) |

Move 190 casos encerrados ou zerados junto. Sem efeito financeiro, mas polui a
Carteira Geral com o que já está fechado. **O cenário da seção 3 é o
recomendado.**

---

## 5. Os 13 que nenhum cenário pega

| Grupo | Qtd. | O que fazer |
|---|---:|---|
| Fichas que dizem Olga e cujo caso está sem operador | 5 | filtrar por **"Sem operador"** na tela e mover junto |
| Fichas que dizem Olga e não têm caso | 8 | não aparecem na Carteira Geral (a tela parte de `casos`) — correção de cadastro, fora desta entrega |

Os **83 acordos dela que vivem em casos de outros operadores** também ficam de
fora: para movê-los seria preciso mover o caso do outro operador. Decisão à
parte.

---

## 6. Todas as portas por onde a Olga ainda pode receber ou assumir

Levantamento completo sobre a definição viva das funções, em 24/09/2026.

| Porta | Antes | Agora |
|---|---|---|
| `nivelamento_automatico_gestao` (cron 09:20) | distribuía para ela | bloqueada |
| `reposicao_carteira_processar` | repunha até 500 | bloqueada |
| `calibragem_simular_nivelamento_impl` | propunha dar a ela | bloqueada |
| `assumir_caso_livre` | **passava** | bloqueada |
| `assumir_caso_livre_aluno` | **passava** | bloqueada |
| `sistema_assumir_atendimento` | exigia operador ativo | bloqueada |
| `assumir_atendimento_aluno` | **passava** | bloqueada |
| `sistema_assumir_receptivo` | exigia operador ativo | bloqueada **e** não tira aluno da Carteira Geral |
| `fila_receptivo_heartbeat` (rodízio) | **entrava na roda** | bloqueada |
| `liberar_casos_fidelizacao_vencida` (cron 08:20) | soltava a Carteira Geral inteira | bloqueada |
| Gestão atribuir para ela | `nome_operador_ativo` exige `ativo` | já bloqueada com `ativo=false` |

### O buraco que estava aberto

`assumir_caso_livre` e `assumir_caso_livre_aluno` se protegem com
`if public.nome_operador_por_email(v_email) is null`. **Aquela função nunca
devolve null** — ela cai em `upper(split_part(email,'@',1))` para qualquer
e-mail. A guarda é letra morta: hoje uma pessoa já desligada, com a sessão ainda
válida, consegue assumir da fila livre. O mesmo vale para
`assumir_atendimento_aluno`.

A porta nova, `internal.operador_pode_receber_caso()`, reusa a definição que já
existe de operador ativo (`internal.nome_operador_ativo`, que exige `ativo` e
perfil) e soma o flag `recebe_novos_casos`. Ou seja: **desligar em
`usuarios.ativo` passa a valer também nessas portas.**

### O receptivo não é autorização para reassumir

`sistema_assumir_receptivo` grava o operador direto em `alunos` e chama
`set_resp_aluno` logo depois: quem atende **leva o caso**. Para quem saiu da
equipe isso seria a porta dos fundos — bastava o aluno ligar. Agora:

- quem não pode receber caso **atende, mas não leva**;
- **ninguém** tira um aluno da Carteira Geral por telefone, nem operador ativo:
  a gestão libera para a fila livre primeiro. O operador ativo continua atendendo
  e registrando normalmente todo o resto — o fluxo legítimo não quebrou.

### O que fazer, na ordem

1. **Em Usuários, marcar a Olga como inativa** (`usuarios.ativo = false`). É o
   desligamento de verdade e, com a correção deste PR, ele passa a fechar todas
   as portas acima.
2. Na Carteira Geral, **fechar a entrada de casos novos** dela — útil enquanto o
   cadastro ainda estiver ativo, e para qualquer pessoa que precise parar de
   receber sem sair da equipe.
3. Só então confirmar o lote.

## 7. `auth.users`: ação administrativa FORA deste PR

**Sim, exige ação administrativa separada.** Em 24/09/2026 a conta
`cobranca03@aelbra.com.br` em `auth.users` está **viva**: não banida
(`banned_until` nulo), não apagada, e-mail confirmado, último acesso em
11/09/2026.

`usuarios.ativo = false` tira as permissões **dentro** do CRM, mas **não**
impede o login: a sessão continua sendo emitida, e um refresh token válido
segue funcionando até expirar.

Isto **não** está neste PR, de propósito: `auth.users` é gerido pelo Supabase
Auth e escrita direta por migration não é suportada — pode quebrar o serviço de
autenticação. A desativação é feita pelo painel do Supabase (Authentication →
Users) ou pela Admin API, e são três coisas distintas:

| Ação | Efeito |
|---|---|
| **Ban** (`banned_until` no futuro) | bloqueia login novo; reversível |
| **Revogar sessões** | derruba o refresh token que ainda estiver valendo |
| **Delete** | remove a conta; irreversível |

Recomendação: **ban + revogar sessões**. O delete apaga o vínculo e pode afetar
o que ainda referencia o `auth.uid` dela.

---

## 8. Checklist de execução (depois da sua conferência)

1. Aplicar as 4 migrations por `apply_migration`, na ordem do timestamp.
2. `select public.carteira_geral_vigia();` — deve vir tudo zerado.
3. **Marcar a Olga como inativa em Usuários** e, no Supabase Auth, banir a conta
   e revogar as sessões (§7 — fora deste PR).
4. Na Carteira Geral, fechar a entrada de casos novos dela.
5. Abrir **Carteira Geral**, filtrar por Olga, cenário da seção 3.
6. **Ver prévia** e conferir 545 / R$ 2.546.943,15 / 227 acordos / 519 retornos.
7. Percorrer a lista dos acordos de terceiros e marcar os que devem ir.
   Se marcar algum, **recalcular a prévia**.
8. Escrever o motivo e confirmar.
9. Guardar o `lote_id` — é ele que `carteira_geral_desfazer_lote` usa.
   O desfazer **recusa** qualquer item que tenha sido assumido, movido de novo
   ou cujo acordo tenha mudado de status desde o lote; nesse caso a linha da
   auditoria fica sem marca de desfeito, e o lote aparece como parcialmente vivo.
10. No dia seguinte, depois das 09:20, rodar `carteira_geral_vigia()` de novo:
    `na_carteira_geral` tem de continuar igual e `saidas_sem_auditoria` em zero.
