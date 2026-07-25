-- ROLLBACK de 20260724230000_hardening_aluno_saldo_pendente_detalhe.sql
--
-- Mantido FORA de supabase/migrations para nao ser aplicado pelo fluxo normal.
-- Restaura a funcao ao corpo original (sem checagem de autorizacao) e reabre
-- EXECUTE para PUBLIC (estado anterior a migration). Idempotente.
--
-- ATENCAO: aplicar este rollback REINTRODUZ a exposicao de dados financeiros
-- (qualquer chamador, inclusive anon, consulta o financeiro de qualquer aluno).
-- Use apenas se a migration causar regressao comprovada.

BEGIN;

CREATE OR REPLACE FUNCTION public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cpf text;
  v_titulos_abertos numeric := 0;
  v_titulos_orfaos  numeric := 0;
  v_parcelas_valor  numeric := 0;
  v_parcelas_qtd    int := 0;
  v_conf_pendentes  int := 0;
  v_total           numeric := 0;
begin
  if p_aluno_id is null then
    return jsonb_build_object('erro','aluno_id nulo','tem_pendencia', true, 'total', null);
  end if;

  select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0')
    into v_cpf from public.alunos where id = p_aluno_id;

  select
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
     and not exists (
       select 1
         from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id
          and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     );

  select count(*), coalesce(sum(coalesce(p.valor,0)),0)
    into v_parcelas_qtd, v_parcelas_valor
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  v_total := v_titulos_abertos + v_titulos_orfaos + v_parcelas_valor;

  return jsonb_build_object(
    'aluno_id',            p_aluno_id,
    'titulos_abertos',     round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada',  p_ignorar_confirmacao_id,
    'total',               round(v_total, 2),
    'tem_pendencia',        (v_total > 0.005 or v_conf_pendentes > 0)
  );
end;
$function$;

-- Reabre o EXECUTE ao estado original (PUBLIC).
GRANT EXECUTE ON FUNCTION public.aluno_saldo_pendente_detalhe(uuid, uuid) TO PUBLIC;

COMMIT;
