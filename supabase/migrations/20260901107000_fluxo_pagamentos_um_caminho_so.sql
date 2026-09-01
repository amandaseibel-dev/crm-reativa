-- Amanda, 31/08: "construa esse movimento de forma organizada para que o
-- sistema crm converse com os relatorios de pagamentos -- um fluxo unico desde
-- a entrada ate a finalizacao do acordo".
--
-- Um orquestrador, com um interruptor por etapa e historico de cada rodada.
-- Etapas que mexem em dinheiro nascem DESLIGADAS: so a gestao liga.
--
-- O marcador `reativa.fluxo_pagamentos='on'` existe porque o cron nao tem JWT
-- -- `auth.role()` volta vazio, NAO 'service_role' -- e sem ele as funcoes
-- barram a propria rotina no portao de permissao.
--
-- NAO EXISTE aqui a etapa `vincular_por_negociacao`. Ela chamava
-- `prime_vincular_por_negociacao`, que tratava "portador 195 + data de
-- pagamento" como assinatura de negociacao. A regra foi INVALIDADA em 01/09:
-- 100% dos titulos do Prime tem paymentDate, inclusive 38.706 que estao
-- ABERTO. O erro de metodo foi testar se os casos conhecidos APARECIAM sob o
-- criterio, sem nunca testar se ele EXCLUIA os demais. Os 1.217 vinculos que
-- ela aplicou foram revertidos. Ver [[portador-195-com-data-igual-e-negociacao]].

create table if not exists public.fluxo_pagamentos_config (
  etapa        text primary key,
  ligado       boolean not null default false,
  observacao   text,
  alterado_em  timestamptz not null default now(),
  alterado_por text
);

create table if not exists public.fluxo_pagamentos_execucoes (
  id              bigserial primary key,
  rodou_em        timestamptz not null default now(),
  origem          text,
  carteira_antes  numeric,
  carteira_depois numeric,
  resultado       jsonb,
  erro            text
);

alter table public.fluxo_pagamentos_config enable row level security;
alter table public.fluxo_pagamentos_execucoes enable row level security;
revoke all on public.fluxo_pagamentos_config, public.fluxo_pagamentos_execucoes from anon;

drop policy if exists fluxo_cfg_gestao on public.fluxo_pagamentos_config;
create policy fluxo_cfg_gestao on public.fluxo_pagamentos_config
  for all to authenticated using (public.usuario_e_gestao()) with check (public.usuario_e_gestao());

drop policy if exists fluxo_exec_gestao on public.fluxo_pagamentos_execucoes;
create policy fluxo_exec_gestao on public.fluxo_pagamentos_execucoes
  for select to authenticated using (public.usuario_e_gestao());

insert into public.fluxo_pagamentos_config (etapa, ligado, observacao) values
  ('amarrar_boleto', true,
   'grava o numero do boleto na parcela do acordo -- so preenche o que esta vazio'),
  ('pos_importacao', true,
   'titulo importado vira PAGO se o extrato mostra pagamento, ou ganha vinculo com o acordo'),
  ('sinalizar_duplicado', true,
   'boleto repetido com os mesmos vencimentos vira sinal -- nunca cancela'),
  ('baixa_por_documento', false,
   'DESLIGADA: da baixa na parcela pelo extrato. Mexe em dinheiro -- ligar so por decisao da gestao')
on conflict (etapa) do nothing;

-- a etapa invalidada sai da configuracao
delete from public.fluxo_pagamentos_config where etapa = 'vincular_por_negociacao';

create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron')
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '900s'
as $function$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
                            'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$function$;

revoke all on function public.fluxo_pagamentos_rodar(text) from public, anon;
grant execute on function public.fluxo_pagamentos_rodar(text) to authenticated, service_role;
