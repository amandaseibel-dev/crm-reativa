-- ACOES MASSIVAS: PAINEL DE REGISTRO SEMPRE VISIVEL (leitura).
--
-- PROBLEMA (relatado pela gestao em 19/10, duas vezes no mesmo dia):
--   "nao tem mais o botao para confirmar o envio da acao" / "nao sei pq sumiu".
--
-- CAUSA, e nao e bug: desde 20261002094233 quem registra e o clique de
-- EXPORTAR -- `acoes_massivas_exportar` grava `confirmado_em = now()` e
-- `registro_automatico = true` na mesma transacao. O painel da tela so
-- renderiza com `lotesPendentes.length > 0`, e `acoes_massivas_lotes_pendentes`
-- devolve apenas lote com `confirmado_em` nulo. Com 0 pendentes, o painel
-- inteiro desaparece e o envio fica sem nenhuma confirmacao visivel.
--
-- DECISAO DA GESTAO (19/10): o painel volta como VITRINE do que foi
-- registrado, sem mexer no registro automatico do Exportar. Esta funcao e a
-- fonte desse painel.
--
-- Diferenca das duas irmas, que nao serviam:
--   * `acoes_massivas_lotes_pendentes` -- so pendentes, e sem `registrados`,
--     `confirmado_em` ou motivo de exclusao: nao da para mostrar "registrado";
--   * `acoes_massivas_lotes_whatsapp`  -- so canal WHATSAPP, e paga um
--     count por aluno (email valido) que este painel nao precisa.
--
-- SO LEITURA: nenhum insert/update/delete. Nada aqui registra acao massiva.
-- Quem registra segue sendo `acoes_massivas_exportar` (automatico) e
-- `acoes_massivas_concluir_lote` (manual, idempotente: lote ja confirmado
-- devolve o `resultado` guardado sem gravar de novo).

create or replace function public.acoes_massivas_lotes_registro(p_dias integer default 7)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_dias int := least(greatest(coalesce(p_dias, 7), 1), 90);
begin
  -- mesmo portao das irmas: lote de acao massiva e restrito a gestao.
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: lotes de acao massiva restritos a gestao.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.id,
             'canal', l.canal,
             'arquivo', l.arquivo,
             'tipo_cobranca', l.tipo_cobranca,
             'operador_email', l.operador_email,
             'operador_nome', (select u.nome from public.usuarios u
                                where lower(u.email) = l.operador_email limit 1),
             'total', l.total,
             'registrados', l.registrados,
             'registro_automatico', l.registro_automatico,
             'exportado_em', l.exportado_em,
             'exportado_por_email', l.exportado_por_email,
             'confirmado_em', l.confirmado_em,
             'confirmado_por_email', l.confirmado_por_email,
             'descartado_em', l.descartado_em,
             'situacao', case
                           when l.descartado_em is not null then 'DESCARTADO'
                           when l.confirmado_em  is null    then 'PENDENTE'
                           else 'REGISTRADO'
                         end,
             -- Lote de setembro nao tem a coluna `registrados` preenchida (ela
             -- nasceu em 02/10); o numero esta no `resultado` desde 17/09.
             'registrados_efetivos', coalesce(l.registrados, (l.resultado->>'registrados')::int),
             -- Quando registrou menos que o total, o porque ja esta guardado no
             -- proprio lote: o painel mostra, em vez de deixar a gestao somar.
             -- `nullif(...,0)` antes do strip: motivo que nao aconteceu some do
             -- payload em vez de chegar como zero -- jsonb_strip_nulls tira
             -- nulo, nao zero, e um "0 em confirmacao de pagamento" na tela
             -- afirma um exame que ninguem fez.
             'excluidos', coalesce(jsonb_strip_nulls(jsonb_build_object(
                 'acionados_apos_exportacao', nullif((l.resultado->>'excluidos_acionados_apos_exportacao')::int, 0),
                 'confirmacao_pagamento',     nullif((l.resultado->>'excluidos_confirmacao')::int, 0),
                 'liquidados_prime',          nullif((l.resultado->>'excluidos_liquidados_prime')::int, 0),
                 'outro_operador',            nullif((l.resultado->>'excluidos_outro_operador')::int, 0),
                 'fora_do_tipo_cobranca',     nullif((l.resultado->>'excluidos_tipo_cobranca')::int, 0))), '{}'::jsonb),
             'excluidos_por_motivo', coalesce(l.resultado->'excluidos_por_motivo', '{}'::jsonb))
           order by l.exportado_em desc)
      from (select *
              from public.acoes_massivas_lotes
             -- Janela para o historico, MAS lote pendente nunca sai do painel,
             -- por mais antigo que seja -- era a garantia do painel anterior,
             -- que listava todo pendente sem recorte de data.
             where exportado_em >= now() - make_interval(days => v_dias)
                or (confirmado_em is null and descartado_em is null)
             order by exportado_em desc
             limit 50) l), '[]'::jsonb);
end;
$function$;

comment on function public.acoes_massivas_lotes_registro(integer) is
  'Lotes de acao massiva dos ultimos N dias (1-90, padrao 7) + TODO lote pendente, '
  'com situacao REGISTRADO/PENDENTE/DESCARTADO, quantos entraram e por que os '
  'demais ficaram de fora. Somente leitura; restrita a gestao. Fonte do painel '
  '"Registro das acoes massivas".';

-- ACL identica as irmas (`acoes_massivas_lotes_pendentes`,
-- `acoes_massivas_lotes_whatsapp`): postgres, authenticated e service_role.
-- Explicito porque funcao nova herda EXECUTE do schema public e `anon` nao
-- pode receber: o portao interno exige gestao, mas a porta nao fica aberta.
revoke all on function public.acoes_massivas_lotes_registro(integer) from public;
grant execute on function public.acoes_massivas_lotes_registro(integer)
  to postgres, authenticated, service_role;
