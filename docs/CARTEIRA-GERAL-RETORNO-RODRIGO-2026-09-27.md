# Retorno de Rodrigo Carvalho de Freitas: 26/09 → 27/09 — CAUSA INDETERMINADA

**Status: não provado.** Registro aberto. Nada foi alterado no retorno dele.

## O fato

| | |
|---|---|
| Aluno | Rodrigo Carvalho de Freitas |
| `aluno_id` | `96ad22da-7258-4674-aecb-8b32093fe4a1` |
| Lote | `559b20bb-d8a6-43d8-8a14-e70d2cdef6fb`, executado 26/09/2026 22:10:05 UTC |
| `retorno_data` congelado na prévia | **2026-09-26** |
| `alunos.data_retorno` em 27/09 | **2026-09-27** |
| hora e origem | inalteradas (`null`, `AUTOMATICO`) |

Os outros 5 alunos do lote têm data, hora e origem **idênticas** ao que a prévia
congelou. Só este divergiu, em +1 dia.

## O que foi verificado (tudo leitura)

1. **`alunos.atualizado_em` é de 29/06/2026.** Quem escreveu `data_retorno` não
   tocou essa coluna. Isso exclui os caminhos que a atualizam.
2. **`audit_log`**: uma única linha para este aluno na janela — a
   `TROCA_RESPONSAVEL` de 22:10:05, do próprio recolhimento. Nenhuma linha de
   mudança de retorno.
3. **`historico_operadores_alunos`**: nenhum registro na janela.
4. **`internal.carteira_geral_trocar_dono`** preserva por construção: lê
   `data_retorno`, `hora_retorno`, `retorno_origem`, `proxima_acao` e
   `retorno_confirmado_em` **antes** de chamar `set_resp_aluno` e escreve os
   mesmos valores de volta. Não recalcula nada.
5. **Crons na janela**: só um job ativo escreve `alunos.data_retorno`
   (`casos_encerrar_zerados_horario` → `casos_encerrar_zerados_sem_debito`), e
   ele trata aluno **zerado**. Rodrigo tem saldo de R$ 1.148,21.
6. **`recalcular_situacao_virada_diaria`** (06:00 de 27/09, sucesso): a função
   **não menciona `data_retorno`**.
7. **Gatilhos de `alunos` e `casos`**: os três que tocam `data_retorno` foram
   descartados —
   - `limpar_retorno_origem` só apaga a **origem**, e só quando a data é nula;
   - `sincronizar_alunos_unificados` escreve **de** `alunos` **para**
     `alunos_unificados` (direção única), e Rodrigo não tem ficha irmã: uma só
     linha com a `chave_unificacao` `NOME:RODRIGO CARVALHO DE FREITAS` e uma só
     com o `registro_unico`;
   - `trg_tabulacao_redireciona` preserva o agendamento de propósito.

## Por que fica indeterminada

Nenhuma das fontes de rastro do sistema (`audit_log`,
`historico_operadores_alunos`, `atualizado_em`) registra a escrita. Sem registro,
o que sobraria é correlação de horário — e **timestamp igual não é prova de
causa**. Preferimos deixar aberto a apontar um culpado errado.

Observação relevante para quem retomar: o padrão é suspeito de "retorno vencido
vira hoje" (era 26/09 no dia 26, virou 27/09 no dia 27), mas não encontramos o
código que faça isso, e os outros 5 do lote **não** foram empurrados — os deles
já eram 27/09 ou 01/10 na prévia. Ou seja: não há evidência de uma varredura
geral.

## O que foi feito em vez de adivinhar

Fixamos o **invariante** em teste real (PGlite, `carteira_geral_comportamento`):
a troca de dono preserva data, hora e origem exatamente, na ida e na volta; não
inventa agendamento para quem não tinha; e **não empurra para hoje** um retorno
vencido — este último reproduz exatamente o padrão do Rodrigo e falharia se
alguém introduzisse esse comportamento no caminho do remanejamento.

O teste não é decorativo: `internal.set_resp_aluno` **zera** `data_retorno`,
`proxima_acao` e `status_acionamento` quando o responsável muda, e o
`carteira_geral_trocar_dono` existe para devolver o agendamento depois disso. Se
alguém simplificar aquela função, o teste quebra.

## O que NÃO foi feito

O retorno do Rodrigo **não foi alterado**. Ele segue 27/09, com a ficha na
Carteira Geral. Corrigir sem saber a causa arriscaria o valor ser reescrito de
novo pelo mesmo caminho desconhecido.

## Como reabrir

Se acontecer outra vez, o caminho mais curto é capturar o escritor em vez de
procurá-lo depois: um gatilho temporário de auditoria em
`UPDATE OF data_retorno ON public.alunos` gravando `current_query()`,
`pg_backend_pid()` e a pilha do PL/pgSQL. Isso exige escrita em produção e
aprovação — não foi feito.
