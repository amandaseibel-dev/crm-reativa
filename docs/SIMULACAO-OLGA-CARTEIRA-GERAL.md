# Simulação — recolher a carteira da Olga (24/09/2026)

**NADA FOI EXECUTADO.** Isto é leitura de produção replicando exatamente a
lógica de `carteira_geral_previa`. Nenhuma linha de titularidade foi alterada,
nenhuma migration foi aplicada.

Operadora: **Olga — `cobranca03@aelbra.com.br`**, perfil `operador`, `ativo = true`.

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
| — parcelas vivas (não pagas/canceladas/estornadas) | **1.012** |
| Mensalidades em aberto nos casos dela | **1.210** títulos, em 329 alunos |
| Casos com retorno agendado (`casos.data_retorno`) | **552** |
| Fichas com retorno agendado (`alunos.data_retorno`) | 532 |
| Termos em nome dela | 152 |
| Links de pagamento em nome dela | 179 |
| Linhas na tabela `retornos` (receptivo) | **0** |

> `retornos` é a fila do receptivo e não tem nada da Olga. O "retorno ativo" que
> importa aqui é o agendamento em `casos.data_retorno` / `alunos.data_retorno`.

**Dinheiro sob responsabilidade dela** (fonte `calibragem_saldo_aluno`):

| Recorte | Alunos | Total | Mensalidade | Acordo |
|---|---:|---:|---:|---:|
| Vivos e com saldo | 545 | **R$ 2.546.943,15** | 819.405,33 | 1.727.537,82 |
| Tudo, inclusive encerrado e saldo zero | 735 | R$ 2.933.642,29 | 943.389,71 | 1.990.252,58 |

---

## 2. Titularidades divergentes

| Divergência | Qtd. | Detalhe |
|---|---:|---|
| Acordo vivo **dela** em caso de **outro** operador | **83** | espalhados por Luana, Mauricio, Nataly, João, Allan, Rafaella, Diego, Fernanda, Amanda gestora e "sem operador" |
| Ficha diz Olga e o caso é de outro | **5** | os 5 casos estão **sem operador** |
| Ficha diz Olga e **não existe caso** | **8** | ficha órfã |
| Acordos (vivos) em casos dela que pertencem a **outro** responsável | **155**, em 141 alunos | entram na seleção como conflito |
| `casos.operador_email` ≠ `alunos.responsavel_atual_email` dentro dos 735 | **0** | as duas fontes estão alinhadas do lado dela |

**Leitura:** filtrar por `casos.operador_email = Olga` pega 735 casos e
**deixa de fora 13 registros** (5 fichas cujo caso está sem operador + 8 fichas
sem caso) e **os 83 acordos dela que moram em casos de outros operadores**.
Esses 83 precisam de decisão separada — mover o acordo sem mover o caso é
justamente o que faz o gatilho `_aluno_segue_dono_do_acordo` agir.

---

## 3. Cenário A — recolher o padrão da tela (recomendado)

Filtro: responsável = Olga, com saldo, sem encerrados. Destino: **Carteira
Geral**. Opção "levar os acordos junto": **marcada**.

### Prévia

| | |
|---|---:|
| Alunos movidos | **545** |
| Valor total | **R$ 2.546.943,15** |
| — mensalidade | R$ 819.405,33 |
| — acordo | R$ 1.727.537,82 |
| Acordos vivos que vão junto | **386** |
| Parcelas vivas nesses acordos | 1.235 |
| Mensalidades em aberto envolvidas | 1.107 títulos |
| Alunos só com mensalidade (sem acordo vivo) | 250 |

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

### Conflitos que a prévia exibirá

| Aviso | Casos |
|---|---:|
| Retorno agendado que será limpo | **519** |
| Acordo de outro responsável indo junto | **155** (141 alunos) |
| Titularidade divergente entre caso e ficha | 0 |
| Caso já encerrado | 0 (cenário exclui encerrados) |

> **Os 519 retornos agendados serão apagados.** Não é escolha da Carteira Geral:
> `internal.set_resp_aluno` zera `data_ultimo_acionamento`, `status_acionamento`,
> `proxima_acao`, `data_retorno` e `hora_retorno` sempre que o responsável muda.
> Vale para qualquer troca de dono no sistema. Se algum desses retornos for
> compromisso assumido com o aluno, tire-os da seleção antes de confirmar.

### O que muda

- `casos.operador_email` → `carteira.geral@reativa.local`
- `alunos.responsavel_atual_email` → idem
- `acordos.operador_responsavel_email` dos 386 acordos vivos → idem

### O que **não** muda

- Quem criou e quem confirmou cada um dos 386 acordos
- `pagamentos.operador_email` — **o honorário e a comissão da Olga por tudo que
  ela já recebeu continuam dela**
- Baixas, parcelas, títulos, valores, status financeiro
- `historico_operadores_alunos` e `aluno_movimentacoes` já gravados

### Resultado esperado

- Olga fica com **190 casos** (735 − 545): os encerrados e os de saldo zero.
- Carteira Geral passa a ter 545 alunos / R$ 2.546.943,15.
- Nenhuma rotina automática pega esses 545: elas só pescam em
  `operador_email IS NULL`, e a Carteira Geral não é nulo.
- Nenhum operador consegue assumi-los pela tela dele, pelo mesmo motivo.
- Para liberar à operação: selecionar na Carteira Geral e mandar para
  **fila livre**, no ritmo que você quiser.

---

## 4. Cenário B — recolher literalmente tudo

Mesma coisa, desmarcando "apenas com saldo" e marcando "incluir encerrados".

| | |
|---|---:|
| Alunos movidos | **735** |
| Valor total | R$ 2.933.642,29 |
| Retornos agendados apagados | **552** |
| Conflito adicional | 171 casos encerrados (mover não os reabre) |

Move 190 casos encerrados ou zerados junto. Não tem efeito financeiro, mas
polui a Carteira Geral com o que já está fechado. **Cenário A é o recomendado.**

---

## 5. Os 13 + 83 que nenhum dos dois cenários pega

| Grupo | Qtd. | O que fazer |
|---|---:|---|
| Fichas que dizem Olga e cujo caso está sem operador | 5 | filtrar por **"Sem operador"** na tela e mover junto |
| Fichas que dizem Olga e não têm caso | 8 | não aparecem na Carteira Geral (a tela parte de `casos`) — precisam de correção de cadastro, fora desta entrega |
| Acordos vivos da Olga em casos de **outros** operadores | 83 | decisão caso a caso: mover o acordo tira o crédito futuro dela, mas **manter** faz o gatilho realinhar o aluno para ela quando não houver mensalidade em aberto |

---

## 6. Antes de confirmar, desligue a distribuição automática

`nivelamento_automatico_gestao` roda **todo dia às 09:20** e distribui para
`usuarios where ativo and perfil='operador'`. **Se a carteira for recolhida hoje
sem desligar isso, a Olga volta a receber casos amanhã de manhã.**

Na tela, usar **"não receber distribuição automática"** para a Olga
(`carteira_geral_definir_distribuicao`) antes de confirmar o lote. Com o flag
desligado ela sai de: o nivelamento das 09:20, a reposição automática e a
simulação de calibragem.

Ela **continua** podendo assumir da fila livre — essa é a regra que você
definiu. Se quiser bloquear isso também, é um segundo interruptor e não está
neste PR.

---

## 7. Checklist de execução (depois da sua conferência)

1. Aplicar as 4 migrations por `apply_migration`, na ordem do timestamp.
2. Conferir `select public.carteira_geral_vigia();` — deve vir tudo zerado.
3. Desligar a distribuição automática da Olga.
4. Abrir **Carteira Geral**, filtrar por Olga, cenário A.
5. **Ver prévia** e conferir os 545 / R$ 2.546.943,15 / 519 retornos.
6. Retirar da seleção os retornos que forem compromisso com o aluno.
7. Escrever o motivo e confirmar.
8. Guardar o `lote_id` do resultado — é ele que `carteira_geral_desfazer_lote`
   usa para reverter tudo.
9. Rodar `carteira_geral_vigia()` de novo no dia seguinte, depois das 09:20:
   `na_carteira_geral` tem de continuar igual e `saidas_sem_auditoria` em zero.
