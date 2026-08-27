-- Fila com valor velho: a entrada chegou depois e ela nao acompanhou.
--
-- Amanda, 27/08/2026: "tire as linhas fantasmas, estao distorcendo os valores".
--
-- Ao cacar fantasma sobraram 11 linhas que nao casavam com acordo nenhum. Elas
-- NAO sao fantasma -- estao com o valor desatualizado, e a diferenca e sempre a
-- ENTRADA:
--
--   Yasmin Silva Pimentel     fila 584,22   acordo 1.168,45   entrada 584,23
--   Pedro Henrique Ferreira   fila 451,25   acordo   902,51   entrada 451,26
--   Dhafyni Bezerra Rosa      fila 105,30   acordo   210,59   entrada 105,29
--   Natael Jordan da Silva  fila 2.511,30   acordo 7.011,30   entrada 4.500,00
--
-- POR QUE ACONTECE. A linha da fila nasce na primeira importacao que traz
-- aquele acordo. Se o titulo da ENTRADA so chega num lote seguinte, o acordo
-- cresce (completar_parcelas_acordo cria a parcela a partir do titulo novo) e a
-- fila fica com o valor antigo. O update de valor dentro de importar_acordos so
-- soma os titulos DAQUELE lote, entao nao corrige o que veio antes.
--
-- REGISTRO DE UM ERRO MEU, para nao se repetir: eu quase tratei esse padrao
-- como inflacao. A parcela grande "igual a soma das outras" parecia inventada
-- -- eram 358 parcelas, R$ 337.741,62. Fui buscar o lastro antes de mexer e o
-- titulo estava la (050694720001, R$ 584,23, no backup de quarentena). Nao e
-- invencao: e ENTRADA DE 50%, produto normal. Apagar aquilo teria destruido
-- divida legitima. O acordo esta certo; quem estava errada era a fila.
--
-- O QUE FAZ. Alinha o valor e a quantidade de parcelas da linha pendente com o
-- acordo, e grava o acordo_id -- que faltava e e o que evita o proximo
-- descasamento. So mexe quando o aluno tem EXATAMENTE UM acordo ATIVO, senao
-- nao da para saber qual e o dono da linha.
--
-- Nao muda saldo: o saldo sai das parcelas do acordo, nunca da fila. Isto
-- conserta o que a tela mostra.
--
-- RESULTADO: das 13 sem casar sobraram 2 (as de aluno com mais de um acordo
-- ativo, que precisam de olho humano).

update public.fila_acordos_confirmar f
   set valor_total  = a.valor_total,
       qtd_parcelas = a.qtd_parcelas,
       acordo_id    = a.id,
       observacao   = coalesce(nullif(btrim(f.observacao),''),
         'Valor alinhado ao acordo: a entrada chegou numa importacao posterior a esta linha.')
  from public.acordos a
 where a.aluno_id = f.aluno_id
   and a.status = 'ATIVO'
   and f.confirmado_em is null
   and coalesce(f.status_confirmacao,'A_CONFIRMAR') = 'A_CONFIRMAR'
   and f.aluno_id is not null
   and round(coalesce(f.valor_total,0),2) <> round(coalesce(a.valor_total,0),2)
   and not exists (
     select 1 from public.acordos a2
      where a2.aluno_id = f.aluno_id
        and round(coalesce(a2.valor_total,0),2) = round(coalesce(f.valor_total,0),2))
   and (select count(*) from public.acordos a3
         where a3.aluno_id = f.aluno_id and a3.status = 'ATIVO') = 1;
