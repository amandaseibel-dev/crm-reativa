-- Informar os honorarios de um acordo que ja existe.
--
-- POR QUE (Amanda, 26/08/2026): "trabalhamos sobre os honorarios e nao valor
-- pago" -- meta, comissao e o numero que o operador persegue sao honorario. E o
-- CRM nao sabia o honorario de quase nenhum acordo:
--
--     2.825 acordos ATIVOS      ->    11 com honorario
--    10.231 parcelas a vencer   ->    36 com honorario
--    proximo mes: R$ 1.460.018 a receber, R$ 326,76 de honorario previsto
--
-- Nao e que nao exista honorario: os acordos vieram por importacao, que nao
-- trazia o campo. Sem um lugar para informar, o operador nao consegue saber
-- quanto tem para entrar -- justamente aquilo pelo qual ele e cobrado.
--
-- COMO DISTRIBUI. O valor e do acordo inteiro e e rateado entre as parcelas
-- AINDA EM ABERTO, na proporcao do valor de cada uma. Parcela ja PAGA nao e
-- tocada: mexer nela reescreveria honorario de fechamento ja fechado. A sobra
-- de centavos vai na ultima, para a soma bater exatamente com o informado.
--
-- A REGRA DE NEGOCIO (Amanda): o honorario da parcela a vencer entra quando ela
-- e paga; se nao for paga, o acordo quebra e ele nao entra. Por isso o
-- honorario mora NA PARCELA -- e nao num total solto do acordo.
--
-- Aceita valor OU percentual: quem lanca as vezes sabe "30%", as vezes sabe
-- "R$ 1.200".

create or replace function public.acordo_definir_honorarios(
  p_acordo_id  uuid,
  p_valor      numeric default null,
  p_percentual numeric default null,
  p_motivo     text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_acordo    public.acordos%rowtype;
  v_total     numeric;
  v_base      numeric;
  v_acumulado numeric := 0;
  v_qtd       int := 0;
  v_i         int := 0;
  v_parcela   record;
  v_quota     numeric;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode alterar honorários.';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'ACORDO_NAO_ENCONTRADO';
  end if;

  if v_acordo.status <> 'ATIVO' then
    raise exception 'ACORDO_NAO_ATIVO: este acordo está % -- honorário só se informa em acordo ativo.', v_acordo.status;
  end if;

  if coalesce(p_valor,0) <= 0 and coalesce(p_percentual,0) <= 0 then
    raise exception 'INFORME_VALOR_OU_PERCENTUAL';
  end if;

  v_total := case
               when coalesce(p_valor,0) > 0 then round(p_valor, 2)
               else round(coalesce(v_acordo.valor_total,0) * p_percentual / 100.0, 2)
             end;

  if v_total <= 0 then
    raise exception 'HONORARIO_ZERADO: o cálculo deu zero -- confira o valor total do acordo.';
  end if;

  select coalesce(sum(valor),0), count(*) into v_base, v_qtd
  from public.parcelas
  where acordo_id = p_acordo_id and status not in ('PAGO','CANCELADA');

  if v_qtd = 0 then
    raise exception 'SEM_PARCELA_EM_ABERTO: não há parcela em aberto para receber o honorário.';
  end if;

  for v_parcela in
    select id, valor from public.parcelas
    where acordo_id = p_acordo_id and status not in ('PAGO','CANCELADA')
    order by numero, id
  loop
    v_i := v_i + 1;
    if v_i = v_qtd then
      v_quota := round(v_total - v_acumulado, 2);
    else
      v_quota := round(v_total * (v_parcela.valor / nullif(v_base,0)), 2);
      v_acumulado := v_acumulado + v_quota;
    end if;
    update public.parcelas set honorarios = v_quota where id = v_parcela.id;
  end loop;

  update public.acordos
     set honorarios_valor = v_total,
         honorarios_percentual = case
             when coalesce(p_percentual,0) > 0 then p_percentual
             when coalesce(valor_total,0) > 0 then round(v_total * 100.0 / valor_total, 2)
             else honorarios_percentual end,
         atualizado_em = now()
   where id = p_acordo_id;

  if v_acordo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_acordo.aluno_id::text,
      'HONORARIO_INFORMADO',
      concat_ws(' ',
        'Honorário do acordo definido em', to_char(v_total,'FM999G999G990D00'),
        'rateado entre', v_qtd::text, 'parcela(s) em aberto.',
        nullif(btrim(coalesce(p_motivo,'')),'')
      ),
      v_email, now(), v_total
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'acordo_id', p_acordo_id,
    'honorario_total', v_total, 'parcelas_ajustadas', v_qtd
  );
end;
$$;

revoke all on function public.acordo_definir_honorarios(uuid, numeric, numeric, text) from public, anon;
grant execute on function public.acordo_definir_honorarios(uuid, numeric, numeric, text) to authenticated;

comment on function public.acordo_definir_honorarios(uuid, numeric, numeric, text) is
  'Informa o honorário de um acordo ATIVO e rateia entre as parcelas em aberto (parcela paga nao e tocada). Aceita valor ou percentual. Grava HONORARIO_INFORMADO no histórico do aluno.';
