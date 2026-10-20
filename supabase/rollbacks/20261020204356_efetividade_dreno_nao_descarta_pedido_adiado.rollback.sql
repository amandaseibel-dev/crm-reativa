-- ROLLBACK de 20261020204356_efetividade_dreno_nao_descarta_pedido_adiado.sql
--
-- SO DDL, SO uma funcao substituida. Nenhuma tabela criada ou derrubada, nenhum
-- gatilho tocado, nenhum agendamento mexido, nenhum dado escrito -- nao ha dado
-- a restaurar. O corpo abaixo e o que estava em producao em 20/10/2026, copiado
-- de 20261007234000_efetividade_invalidacao_e_reconstrucao_sob_demanda.sql
-- palavra por palavra.
--
-- ATENCAO: este rollback REINTRODUZ o descarte silencioso. Com ele, quando duas
-- passadas se cruzam, `carteira_efetividade_recalcular` devolve
-- `ja_em_andamento` sem recalcular e o pedido e apagado de qualquer forma: a
-- fotografia fica velha e `atualizacao_pendente` apaga sem que o numero tenha
-- sido refeito. Nao e preciso desagendar nada para reverter -- o estado anterior
-- e exatamente o de hoje.
--
-- A chave `adiados` do retorno desaparece. Quem le o retorno do dreno e so o
-- cron (job 69) e os testes; nenhuma tela consome esse JSON.
--
-- NAO TOCADO por esta migration e portanto sem reversao:
--   carteira_efetividade_recalcular, carteira_efetividade_invalidar,
--   carteira_efetividade_solicitar_atualizacao, carteira_efetividade_ler,
--   carteira_safra_situacoes, carteira_em_aberto_por_status_academico,
--   carteira_pendencias_por_motivo, os 4 gatilhos de invalidacao, as tabelas de
--   fotografia e de invalidacao, os jobs 69 e 70.

create or replace function public.carteira_efetividade_recalcular_pendentes()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_linha  record;
  v_feitos jsonb := '[]'::jsonb;
  v_erros  jsonb := '[]'::jsonb;
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
      perform public.carteira_efetividade_recalcular(v_linha.recorte);
      -- So apaga o pedido que ESTE recalculo atendeu. Pedido que chegou depois
      -- (invalidado_em maior) fica para a proxima passada.
      delete from public.carteira_efetividade_invalidacao
       where recorte = v_linha.recorte
         and invalidado_em <= v_linha.invalidado_em;
      v_feitos := v_feitos || jsonb_build_object(
        'recorte', v_linha.recorte, 'pedidos_coalescidos', v_linha.pedidos);
    exception when others then
      -- Um recorte quebrado nao pode impedir os outros de atualizar. A marca
      -- fica, e as :40 ou a proxima passada tentam de novo.
      v_erros := v_erros || jsonb_build_object('recorte', v_linha.recorte, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', jsonb_array_length(v_erros) = 0,
                            'reconstruidos', v_feitos, 'erros', v_erros, 'em', now());
end;
$function$;

comment on function public.carteira_efetividade_recalcular_pendentes() is
  'Dreno da Efetividade: reconstroi apenas os recortes marcados como desatualizados. '
  'Roda pelo cron, fora da requisicao do usuario. Nunca e chamada pelo front.';
