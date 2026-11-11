# Central ULBRA — fila de produtividade do operador

Estado em 09/11/2026: **front e consulta preparados; migration NÃO aplicada; operadores
NÃO liberados.** Complementa [`mensageria-ulbra.md`](mensageria-ulbra.md) e
[`desenho-operacao-mensageria-ulbra.md`](desenho-operacao-mensageria-ulbra.md).

## O que existe

| Peça | Onde | Estado |
|---|---|---|
| Tela `/central-ulbra`, menu Operação | `src/pages/CentralUlbra.jsx`, `src/utils/ulbraCentral.js` | no código; visível **só à gestão** (`CENTRAL_ULBRA_LIBERADA_OPERADORES = false`) |
| Consulta `ulbra_central_operador(p_operador, p_limite, p_pagina)` | `supabase/aguardando_aprovacao/20261109150000_ulbra_central_operador.sql.pendente` (+ `.rollback.sql`) | **não aplicada**, sem linha M1 |
| Provas | `supabase/tests/ulbra_central/`, job `ulbra-central-sql` do CI | portão, isolamento entre operadores, gestão, paginação, rollback |
| Link no sino | `src/components/NotificacoesUlbra.jsx` | "abrir Central ULBRA", só para quem pode vê-la |

Sem a consulta aplicada, a tela diz "A Central ainda não está disponível" — nunca fila vazia.

## As três filas

1. **Respostas aguardando ação** — conversas com CPF confirmado cuja última mensagem é do
   aluno; mais antiga primeiro.
2. **Sem interação válida há mais tempo** — alunos com conversa ou atendimento na
   Mensageria, fora do prazo de 7 dias; mais dias primeiro. Regra existente:
   `casos.data_ultimo_acionamento` e as faixas de `src/utils/carteiraFila.js`
   (8 atenção, 9–10 crítico, 11+ perdendo o caso, nunca acionado).
3. **Novos atendimentos destinados ao operador** — destino CARTEIRA ou RODÍZIO, sem
   responsável; entrada mais antiga primeiro.

Cada linha: motivo, tempo, **responsável no ReATIVA** e **atendente na Mensageria** em
campos separados, e "Abrir ficha" só com `aluno_id` (vínculo confirmado por CPF).

## Regras que não se negociam

- **O recorte é do banco.** Quem não é gestão recebe só o próprio universo; `p_operador` é
  ignorado. O dono é `casos.operador_email`, a mesma fonte da coleta e do sino. A RLS das
  tabelas `ulbra_*` **não** foi aberta e `ulbra_painel_gestao()` segue só da gestão.
- **Resposta aguardando ≠ não lida ≠ sem acionamento.** A conversa só sai da fila 1 quando a
  Mensageria mostrar mensagem do operador depois da do aluno. Marcar como lida e acionamento
  posterior no ReATIVA aparecem como informação e **não** a retiram: nenhum dos dois comprova
  resposta à mensagem. Uma regra de saída diferente exige definição explícita e validada.
- **Conferência não sai por esta consulta**, nem para a gestão (isso é do painel).
- **Estado da coleta sempre visível:** atualização manual (neutra, com a data), coleta
  automática atrasada, falha, e coleta incompleta ou pulada por orçamento como detalhe.
- **Paginação com ordem total:** critério de prioridade e, no empate, o id. `totais` vai em
  toda página.
- **Filtros na URL**; ao abrir a ficha a tela guarda filtros, páginas carregadas e rolagem, e
  os devolve ao voltar com os mesmos filtros.

## Fora desta entrega (desenho aprovado, nada implementado)

- **Oferta e aceite de atendimentos livres.** Ordem = fila do receptivo existente (sem
  rodízio novo). Prazo para **aceitar**: 30 s, configurável pela gestão; vencido vira "oferta
  expirada", separado de recusa. Aceite e expiração atômicos sobre a mesma linha, com o
  relógio do banco. O botão será **"Aceitar e abrir ficha"**: a ficha só abre depois da
  confirmação exclusiva do banco. Nesta entrega a tela mostra o bloco como indisponível.
- **Presença no CRM.** Operador não é ausente porque a aba da Central ficou oculta: ele pode
  estar em outra ficha. A presença proposta é **atividade em qualquer tela do ReATIVA**
  (interação recente em qualquer aba do CRM, levada pelo heartbeat que já roda em todas as
  telas), somada a "sem pausa" e "sem outra oferta aberta". Visibilidade de aba não entra.
- Cron de coleta, Realtime, mapeamento operador × atendente, assumir, envio, transferência
  e redistribuição.

## Para liberar aos operadores (ordem)

1. Linha M1 e aplicação da `20261109150000` pela gestão; ledger.
2. Conferir em produção grants e `search_path` da função.
3. PR própria mudando `CENTRAL_ULBRA_LIBERADA_OPERADORES` para `true`.

Capturas: [`capturas/central-ulbra-2026-11-09/`](capturas/central-ulbra-2026-11-09/).
