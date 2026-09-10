-- HONORARIO DO PAGAMENTO: ver e corrigir pela Projecao.
--
-- Pedido da gestao em 10/09/2026. Ate aqui o honorario vinha pronto no arquivo
-- importado e NAO havia como corrigir: a unica funcao de honorario que existia
-- (`acordo_definir_honorarios`) mexe no acordo, nao no pagamento. Um honorario
-- errado ficava errado para sempre, e ele e a base da comissao.
--
-- Medido no dia: 619 pagamentos fora do padrao de ~7,3% nos dois ultimos meses
-- -- 505 abaixo, 91 acima e 23 com honorario ZERO, recuperacao que nao gerou
-- comissao para ninguem.
--
-- Restrito a Amanda e Fernanda, SEM a Amanda ADM: ela ajusta operador, mas nao
-- honorario -- quem decide remuneracao e quem responde por ela.
create table if not exists public.historico_honorario_projecao (
  id             bigserial primary key,
  pagamento_id   uuid not null references public.pagamentos(id) on delete cascade,
  valor_anterior numeric,
  valor_novo     numeric,
  alterado_por   text not null,
  motivo         text,
  criado_em      timestamptz not null default now()
);
alter table public.historico_honorario_projecao enable row level security;
drop policy if exists historico_honorario_leitura on public.historico_honorario_projecao;
create policy historico_honorario_leitura on public.historico_honorario_projecao
  for select to authenticated using (public.usuario_e_gestao());
create index if not exists idx_hist_honorario_pagamento
  on public.historico_honorario_projecao (pagamento_id, criado_em desc);

-- Lista do mes, com o percentual efetivo e a classificacao de cada linha.
create or replace function public.projecao_honorarios_listar(p_mes text default null, p_somente_fora boolean default true)
returns table (
  pagamento_id uuid, data_pagamento date, aluno_nome text,
  operador_email text, operador_nome text,
  valor_pago numeric, valor_honorario numeric, percentual numeric,
  situacao text, ja_ajustado boolean, ajustado_em timestamptz, ajustado_por text
)
language sql stable security definer set search_path = public
as $$
  with mes as (select coalesce(p_mes, to_char(current_date,'YYYY-MM')) m),
  base as (
    select p.id, p.data_pagamento, p.aluno_nome, p.operador_email, p.operador_nome,
           p.valor_pago, p.valor_honorario,
           round(100.0 * p.valor_honorario / nullif(p.valor_pago,0), 2) pct,
           (select h.criado_em from public.historico_honorario_projecao h
             where h.pagamento_id = p.id order by h.criado_em desc limit 1) ajustado_em,
           (select h.alterado_por from public.historico_honorario_projecao h
             where h.pagamento_id = p.id order by h.criado_em desc limit 1) ajustado_por
      from public.pagamentos p, mes
     where to_char(p.data_pagamento,'YYYY-MM') = mes.m
  )
  select b.id, b.data_pagamento, b.aluno_nome, b.operador_email, b.operador_nome,
         b.valor_pago, b.valor_honorario, b.pct,
         case when b.pct is null then 'SEM_BASE'
              when b.valor_honorario = 0 then 'ZERADO'
              when b.pct between 7.0 and 7.6 then 'PADRAO'
              when b.pct < 7.0 then 'ABAIXO'
              else 'ACIMA' end,
         b.ajustado_em is not null, b.ajustado_em, b.ajustado_por
    from base b
   where not p_somente_fora
      or b.pct is null or b.valor_honorario = 0
      or b.pct not between 7.0 and 7.6
   order by b.valor_pago desc;
$$;

create or replace function public.projecao_alterar_honorario(
  p_pagamento_id uuid, p_novo_valor numeric, p_motivo text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_ant numeric; v_pago numeric; v_mes text; v_retro boolean;
begin
  -- Amanda e Fernanda. A Amanda ADM ajusta operador, mas NAO honorario: quem
  -- decide remuneracao e quem responde por ela.
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    raise exception 'Sem permissão para ajustar honorário.';
  end if;
  if p_novo_valor is null or p_novo_valor < 0 then
    raise exception 'Informe um valor de honorário válido.';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'O motivo do ajuste é obrigatório.';
  end if;

  select valor_honorario, valor_pago, to_char(data_pagamento,'YYYY-MM'), coalesce(retroativo,false)
    into v_ant, v_pago, v_mes, v_retro
    from public.pagamentos where id = p_pagamento_id;
  if not found then raise exception 'Pagamento não encontrado.'; end if;

  -- Honorario maior que o proprio pagamento e quase sempre digito trocado.
  if v_pago is not null and v_pago > 0 and p_novo_valor > v_pago then
    raise exception 'O honorário (%) não pode ser maior que o valor pago (%).', p_novo_valor, v_pago;
  end if;

  update public.pagamentos set valor_honorario = p_novo_valor where id = p_pagamento_id;

  insert into public.historico_honorario_projecao (pagamento_id, valor_anterior, valor_novo, alterado_por, motivo)
  values (p_pagamento_id, v_ant, p_novo_valor, v_email, btrim(p_motivo));

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'ALTEROU_HONORARIO', 'pagamentos', p_pagamento_id,
          jsonb_build_object('valor_anterior', v_ant, 'valor_novo', p_novo_valor,
                             'motivo', btrim(p_motivo), 'mes_referencia', v_mes));

  -- A Projecao do mes tem que refletir na hora, senao a gestao corrige e
  -- continua vendo o numero velho.
  if v_mes is not null and not v_retro then
    perform public.projecao_snapshot_atualizar(v_mes);
  end if;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
                            'valor_anterior', v_ant, 'valor_novo', p_novo_valor);
end;
$$;

revoke all on function public.projecao_honorarios_listar(text, boolean) from public, anon;
revoke all on function public.projecao_alterar_honorario(uuid, numeric, text) from public, anon;
grant execute on function public.projecao_honorarios_listar(text, boolean) to authenticated;
grant execute on function public.projecao_alterar_honorario(uuid, numeric, text) to authenticated;

comment on function public.projecao_alterar_honorario(uuid, numeric, text) is
  'Corrige o honorario de um pagamento. So Amanda e Fernanda; motivo obrigatorio; grava historico e auditoria e recalcula o snapshot do mes.';
