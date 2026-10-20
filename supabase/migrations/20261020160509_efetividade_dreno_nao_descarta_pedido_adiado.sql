-- EFETIVIDADE: o dreno para de descartar pedido que ele nao atendeu.
--
-- O QUE ESTA ERRADO HOJE (uma funcao, tres linhas)
--
-- `carteira_efetividade_recalcular` tem uma guarda de concorrencia que o proprio
-- autor documentou em 20261008113000: dois recalculos ao mesmo tempo gastariam o
-- dobro do banco para gravar a mesma coisa, entao o segundo DESISTE e DIZ que
-- desistiu --
--
--   if not pg_try_advisory_xact_lock(hashtext('carteira_efetividade_recalcular')) then
--     return jsonb_build_object('ja_em_andamento', true, 'verificado_em', now());
--   end if;
--
-- e o comentario de la diz por que isso importa: "o dreno roda de 5 em 5 min e
-- uma passada pode levar mais de 5 min num dia ruim".
--
-- Mas `carteira_efetividade_recalcular_pendentes` (20261007234000) chama com
-- `perform` -- descarta o retorno -- e apaga o pedido em seguida:
--
--   perform public.carteira_efetividade_recalcular(v_linha.recorte);
--   delete from public.carteira_efetividade_invalidacao
--    where recorte = v_linha.recorte and invalidado_em <= v_linha.invalidado_em;
--
-- Quando o lock esta tomado, o recalculo NAO acontece e o pedido e apagado do
-- mesmo jeito. A fotografia fica velha, `atualizacao_pendente` apaga, e ninguem
-- -- nem a tela, nem o dreno seguinte -- sabe que ficou algo para fazer. O
-- numero so se corrige na proxima escrita ou na rede de seguranca horaria.
--
-- Nao e caso teorico: o max medido de uma passada do dreno em 24 h foi 134 s,
-- 45% da janela de 5 min, com 2 execucoes nao bem-sucedidas no mesmo periodo.
--
-- O QUE MUDA
--
-- O retorno passa a ser lido. Se vier `ja_em_andamento`, o pedido FICA na fila e
-- o recorte entra em `adiados` -- a proxima passada (5 min) o atende. O caminho
-- de erro continua exatamente como era: a excecao aborta antes do `delete`, o
-- pedido sobrevive e e retentado. Ou seja, este patch reusa um caminho de
-- retentativa que ja existe e ja e testado; nao cria modo de falha novo.
--
-- O QUE NAO MUDA
--
--  * Nenhum criterio de calculo. Nenhuma das tres funcoes de payload
--    (`carteira_safra_situacoes`, `carteira_em_aberto_por_status_academico`,
--    `carteira_pendencias_por_motivo`) e tocada. Mesmo numero, mesma regua.
--  * Nenhum agendamento. Jobs 69 (`carteira_efetividade_dreno`) e 70
--    (`carteira_efetividade_hora`) ficam como estao.
--  * Nenhum gatilho, nenhuma tabela, nenhum grant, nenhuma coluna.
--  * A guarda do pedido mais novo (`invalidado_em <= v_linha.invalidado_em`,
--    20261007234000) continua igual e continua testada.
--  * `ok` segue sendo "nenhum erro". Pedido adiado NAO e erro -- e trabalho
--    pendente, e por isso ganhou chave propria em vez de entrar em `erros`.
--
-- Reversivel: supabase/rollbacks/20261020160509_*.rollback.sql devolve o corpo
-- anterior, palavra por palavra. Nenhum dado e alterado em nenhum dos sentidos.

create or replace function public.carteira_efetividade_recalcular_pendentes()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_linha   record;
  v_feitos  jsonb := '[]'::jsonb;
  v_erros   jsonb := '[]'::jsonb;
  v_adiados jsonb := '[]'::jsonb;
  v_r       jsonb;
begin
  for v_linha in
    select i.recorte, i.invalidado_em, i.pedidos
      from public.carteira_efetividade_invalidacao i
      left join public.carteira_efetividade_snapshot s
             on s.recorte = i.recorte and s.bloco = 'seis_linhas'
     where s.gerado_em is null or i.invalidado_em > s.gerado_em
     order by i.invalidado_em
  loop
    begin
      -- O retorno e LIDO. Era aqui o `perform` que jogava fora a unica
      -- informacao que diz se o trabalho foi feito.
      v_r := public.carteira_efetividade_recalcular(v_linha.recorte);

      if coalesce((v_r->>'ja_em_andamento')::boolean, false) then
        -- Nada foi recalculado: o lock estava tomado por outra passada. O
        -- pedido FICA, intacto, para a proxima rodada do dreno.
        v_adiados := v_adiados || jsonb_build_object(
          'recorte', v_linha.recorte, 'motivo', 'ja_em_andamento',
          'invalidado_em', v_linha.invalidado_em,
          'pedidos_coalescidos', v_linha.pedidos);
      else
        -- So apaga o pedido que ESTE recalculo atendeu. Pedido que chegou depois
        -- (invalidado_em maior) fica para a proxima passada.
        delete from public.carteira_efetividade_invalidacao
         where recorte = v_linha.recorte
           and invalidado_em <= v_linha.invalidado_em;
        v_feitos := v_feitos || jsonb_build_object(
          'recorte', v_linha.recorte, 'pedidos_coalescidos', v_linha.pedidos);
      end if;
    exception when others then
      -- Um recorte quebrado nao pode impedir os outros de atualizar. A marca
      -- fica, e a rede de seguranca horaria ou a proxima passada tentam de novo.
      v_erros := v_erros || jsonb_build_object('recorte', v_linha.recorte, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', jsonb_array_length(v_erros) = 0,
                            'reconstruidos', v_feitos,
                            'adiados', v_adiados,
                            'erros', v_erros, 'em', now());
end;
$function$;

comment on function public.carteira_efetividade_recalcular_pendentes() is
  'Dreno da Efetividade: reconstroi apenas os recortes marcados como desatualizados. '
  'Roda pelo cron, fora da requisicao do usuario. Nunca e chamada pelo front. '
  'Pedido so e apagado quando o recalculo realmente aconteceu: retorno '
  '`ja_em_andamento` deixa o pedido na fila e o recorte em `adiados`.';
