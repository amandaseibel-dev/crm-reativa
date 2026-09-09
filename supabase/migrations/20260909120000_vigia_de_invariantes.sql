-- O VIGIA DE INVARIANTES.
--
-- POR QUE ELE EXISTE. Em 08 e 09/09/2026 foram descobertos, um a um e a mao:
--   * um cron caido havia 96 horas, sem avisar ninguem;
--   * 219 fichas cobrando com o nome de outra pessoa;
--   * 53 acordos quitados sem lastro de pagamento;
--   * 1.287 titulos cobrados depois de o Prime registrar o pagamento;
--   * 4 alunos com duas fichas, R$ 15.202,96 contados em dobro;
--   * 34 fichas fantasma segurando R$ 89.988,24 em pagamentos, que eu mesmo
--     dei por reparadas em 09/09 e o vigia mostrou que continuam la.
--
-- Nenhum deles foi encontrado por alarme. Todos por alguem tropecar. Este vigia
-- transforma cada um numa checagem que roda sozinha todo dia.
--
-- O QUE ELE NAO FAZ, de proposito: nao corrige nada. Ele conta e registra. Toda
-- correcao automatica que este sistema tentou -- baixa pelo Prime, exclusao por
-- titulo repetido -- teria destruido dinheiro legitimo. O vigia aponta; gente
-- decide.
--
-- CADA CHECAGEM CARREGA O NUMERO QUE ELA TINHA EM 09/09. Serve de linha de
-- base: se amanha o numero pular, alguma coisa mudou.
--
-- Custo medido das consultas: ~10s no total. Roda de madrugada e respeita o
-- disjuntor sistema_sob_carga.

create table if not exists public.invariante_config (
  nome        text primary key,
  ligado      boolean not null default true,
  severidade  text not null default 'ATENCAO' check (severidade in ('GRAVE','ATENCAO','INFO')),
  titulo      text not null,
  explicacao  text,
  base_09_09  text
);

create table if not exists public.invariante_resultado (
  id          bigserial primary key,
  nome        text not null,
  achados     bigint not null default 0,
  valor       numeric,
  detalhe     jsonb,
  rodado_em   timestamptz not null default now(),
  duracao_ms  integer
);

create index if not exists ix_invariante_resultado_nome_data
  on public.invariante_resultado (nome, rodado_em desc);

alter table public.invariante_config    enable row level security;
alter table public.invariante_resultado enable row level security;

drop policy if exists invariante_config_gestao_le on public.invariante_config;
create policy invariante_config_gestao_le on public.invariante_config
  for select using (public.usuario_e_gestao());

drop policy if exists invariante_resultado_gestao_le on public.invariante_resultado;
create policy invariante_resultado_gestao_le on public.invariante_resultado
  for select using (public.usuario_e_gestao());

comment on table public.invariante_resultado is
  'O que o vigia encontrou em cada rodada. Nao corrige nada: conta e registra.';

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09) values
 ('cron_com_falha','GRAVE','Rotina automática falhando',
  'Cron que falha não avisa ninguém. Foi assim que casos_reabrir_com_divida ficou 96 horas fora do ar.','10 (as quedas de 08/09, antes da correção da trava)'),
 ('titulo_aberto_liquidado_no_prime','GRAVE','Cobrando quem já pagou',
  'Título aberto no CRM que o Prime registra como liquidado de verdade (vencimento+30 E depois da importação).','1.150 · R$ 2.104.780,38'),
 ('parcela_paga_sem_pagamento','GRAVE','Parcela paga sem lastro',
  'Parcela paga sem lastro nenhum: nem pagamento com o mesmo número de título, nem qualquer pagamento do aluno de junho/2026 em diante.','28 · R$ 44.274,92 (13 alunos)'),
 ('ficha_com_mais_de_um_cpf','GRAVE','Ficha com CPF de outra pessoa',
  'A ficha carrega títulos de CPFs diferentes. Cobrar quem não deve é LGPD, não só número errado.','7'),
 ('aluno_com_duas_fichas','GRAVE','Aluno com duas fichas abertas',
  'A mesma dívida contada duas vezes. Protegido por índice único desde 09/09.','0'),
 ('acordo_saldo_vs_parcelas','ATENCAO','Acordo não bate com as próprias parcelas',
  'O valor total do acordo difere da soma das parcelas não canceladas.','19'),
 ('acordo_quitado_com_parcela_aberta','ATENCAO','Acordo quitado com parcela em aberto',
  'O acordo diz quitado mas ainda tem parcela a vencer ou vencida.','0'),
 ('caso_saldo_zero_na_fila','ATENCAO','Ficha sem dívida ocupando a fila',
  'Caso não encerrado cujo aluno não deve nada.','0'),
 ('parcela_documento_de_outro_aluno','GRAVE','Documento da parcela é de outro aluno',
  'O boleto da parcela pertence ao título de outro aluno.','0'),
 ('matview_saude_velha','ATENCAO','Saúde da Carteira desatualizada',
  'A matview passou de 2 horas sem recalcular. Já ficou 4 dias congelada uma vez.','0 (recalculada as 10:00)'),
 ('bordero_atrasado','ATENCAO','Borderô atrasado',
  'Mais de 35 dias sem borderô novo. O borderô é mensal; sem ele a base para no tempo.','29 dias (ultimo em 11/08)'),
 ('acordo_sem_origem','INFO','Acordo que não diz de onde veio',
  'Acordo ativo sem título vinculado: não se sabe qual dívida ele substituiu.','1.268'),
 ('acordo_ativo_sem_responsavel','INFO','Acordo ativo sem operador',
  'Ninguém enxerga esses acordos na fila.','841 · R$ 1.203.071,46'),
 ('ficha_fantasma_com_pagamento','GRAVE','Ficha fantasma segurando pagamento',
  'Ficha sem CPF, sem caso e sem acordo, com pagamento pendurado nela: dinheiro recebido que não aparece em nenhuma carteira. 17 das 34 têm ficha gêmea com CPF e mesmo nome — candidatas a fusão, que só a gestão decide.','34 · R$ 89.988,24 (NÃO reparadas)')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo,
      explicacao = excluded.explicacao, base_09_09 = excluded.base_09_09;

-- ---------------------------------------------------------------------------
-- O VIGIA. Le, conta e registra. Nunca escreve em tabela de negocio.
-- ---------------------------------------------------------------------------
create or replace function public.invariantes_rodar(p_nome text default null)
returns table (nome text, achados bigint, valor numeric)
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v record; v_n bigint; v_v numeric; v_d jsonb;
  v_t timestamptz; v_mv timestamptz;
begin
  for v in select c.nome from public.invariante_config c
           where c.ligado and (p_nome is null or c.nome = p_nome)
           order by c.nome loop
    v_t := clock_timestamp(); v_n := 0; v_v := null; v_d := null;

    case v.nome

      -- Cron que falhou nas ultimas 24h. Foi o que ficou 96h invisivel.
      when 'cron_com_falha' then
        select count(*), jsonb_agg(distinct j.jobname)
          into v_n, v_d
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
         where d.status = 'failed'
           and d.start_time > now() - interval '24 hours';

      -- Titulo aberto no CRM que o Prime liquidou DE VERDADE.
      -- Liquidacao real = depois do vencimento+30 E depois da importacao.
      -- O placeholder do Prime cai em titulo aberto e enganaria a conta.
      when 'titulo_aberto_liquidado_no_prime' then
        select count(*), round(sum(t.saldo_corrigido), 2) into v_n, v_v
          from public.acordos_titulos t
          join public.prime_extrato p on p.boleto = t.documento
         where t.status = 'em_aberto'
           and p.liquidado_em is not null
           and p.liquidado_em > p.vencimento + 30
           and p.liquidado_em > t.created_at::date;

      -- Parcela dada como paga sem lastro NENHUM: nem pagamento com o mesmo
      -- numero de titulo, nem qualquer pagamento do aluno de junho/2026 pra ca.
      when 'parcela_paga_sem_pagamento' then
        select count(*), round(sum(pa.valor), 2) into v_n, v_v
          from public.parcelas pa
          join public.acordos a on a.id = pa.acordo_id
         where pa.status = 'PAGO'
           and pa.pago_em >= date '2026-06-01'
           and pa.boleto is not null and length(pa.boleto) = 11
           and not exists (
                 select 1 from public.pagamentos g
                  where g.numero_parcela_completo is not null
                    and substring(g.numero_parcela_completo, 2, 7) = substring(pa.boleto, 2, 7))
           and not exists (
                 select 1 from public.pagamentos g2
                  where g2.aluno_id = a.aluno_id
                    and g2.data_pagamento >= date '2026-06-01');

      when 'ficha_com_mais_de_um_cpf' then
        select count(*) into v_n from (
          select t.aluno_id from public.acordos_titulos t
           where t.aluno_id is not null and t.cpf is not null
           group by 1 having count(distinct t.cpf) > 1) x;

      when 'aluno_com_duas_fichas' then
        select count(*) into v_n from (
          select c.cpf from public.casos c
           where coalesce(c.encerrado_operacional, false) = false and c.cpf is not null
           group by 1 having count(*) > 1) y;

      -- O acordo nao bate com as proprias parcelas (canceladas fora).
      when 'acordo_saldo_vs_parcelas' then
        select count(*), round(sum(x.diferenca), 2) into v_n, v_v from (
          select a.id, abs(a.valor_total - sum(p.valor)) as diferenca
            from public.acordos a
            join public.parcelas p on p.acordo_id = a.id and p.status <> 'CANCELADA'
           where a.status = 'ATIVO'
           group by a.id, a.valor_total
          having abs(a.valor_total - sum(p.valor)) > 0.01) x;

      when 'acordo_quitado_com_parcela_aberta' then
        select count(*), round(sum(x.aberto), 2) into v_n, v_v from (
          select a.id, sum(p.valor) as aberto
            from public.acordos a
            join public.parcelas p on p.acordo_id = a.id
           where a.status = 'QUITADO' and p.status in ('A_VENCER','VENCIDA')
           group by a.id) x;

      when 'caso_saldo_zero_na_fila' then
        select count(*) into v_n from public.casos c
         where coalesce(c.encerrado_operacional, false) = false
           and coalesce(c.saldo_total, c.total_em_aberto, 0) = 0;

      -- O boleto da parcela (11 digitos: 5 + titulo + parcela) aponta para um
      -- titulo de OUTRO aluno. Foi assim que 10 parcelas baixaram no aluno errado.
      when 'parcela_documento_de_outro_aluno' then
        select count(*) into v_n
          from public.parcelas pa
          join public.acordos a on a.id = pa.acordo_id
          join public.acordos_titulos t on t.documento = substring(pa.boleto, 2, 7)
         where pa.boleto is not null and length(pa.boleto) = 11
           and t.aluno_id is not null and a.aluno_id is not null
           and t.aluno_id <> a.aluno_id;

      -- Idade da Saude da Carteira, em minutos. Ja ficou 4 dias congelada
      -- enquanto a tela dizia estar atualizada.
      when 'matview_saude_velha' then
        select m.atualizado_em into v_mv from public.saude_carteira_mv_meta m limit 1;
        v_n := coalesce(extract(epoch from (now() - v_mv))::bigint / 60, 99999);
        v_d := jsonb_build_object('atualizado_em', v_mv);
        if v_n <= 120 then v_n := 0; end if;

      when 'bordero_atrasado' then
        select coalesce(extract(day from now() - max(i.created_at))::bigint, 999) into v_n
          from public.importacoes i
         where i.tipo = 'BORDERO' and coalesce(i.status, '') <> 'EXCLUIDA';
        if v_n <= 35 then v_n := 0; end if;

      when 'acordo_sem_origem' then
        select count(*), round(sum(a.saldo), 2) into v_n, v_v
          from public.acordos a
         where a.status = 'ATIVO'
           and not exists (select 1 from public.acordos_titulos t where t.acordo_id = a.id);

      when 'acordo_ativo_sem_responsavel' then
        select count(*), round(sum(a.saldo), 2) into v_n, v_v
          from public.acordos a
         where a.status = 'ATIVO' and a.operador_responsavel_email is null;

      when 'ficha_fantasma_com_pagamento' then
        select count(*), round(sum(x.valor), 2) into v_n, v_v from (
          select al.id, sum(g.valor_pago) as valor
            from public.alunos al
            join public.pagamentos g on g.aluno_id = al.id
           where al.cpf is null
             and not exists (select 1 from public.casos c where c.aluno_id = al.id)
             and not exists (select 1 from public.acordos ac where ac.aluno_id = al.id)
           group by al.id) x;

      else v_n := 0;
    end case;

    insert into public.invariante_resultado (nome, achados, valor, detalhe, duracao_ms)
    values (v.nome, coalesce(v_n, 0), v_v, v_d,
            extract(milliseconds from clock_timestamp() - v_t)::int);

    nome := v.nome; achados := coalesce(v_n, 0); valor := v_v; return next;
  end loop;
end;
$$;

comment on function public.invariantes_rodar(text) is
  'Roda as checagens ligadas e grava o resultado. Nao corrige nada.';

-- ---------------------------------------------------------------------------
-- Leitura da tela: ultimo resultado de cada checagem, com a linha de base e a
-- variacao desde a rodada anterior.
-- ---------------------------------------------------------------------------
create or replace function public.invariantes_painel()
returns table (
  nome text, titulo text, severidade text, explicacao text, base_09_09 text,
  ligado boolean, achados bigint, valor numeric, detalhe jsonb,
  rodado_em timestamptz, variacao bigint
)
language sql
security definer
set search_path = public
as $$
  with ultimos as (
    select distinct on (r.nome) r.* from public.invariante_resultado r
     order by r.nome, r.rodado_em desc
  ), anteriores as (
    select distinct on (r.nome) r.* from public.invariante_resultado r
     join ultimos u on u.nome = r.nome and r.rodado_em < u.rodado_em
     order by r.nome, r.rodado_em desc
  )
  select c.nome, c.titulo, c.severidade, c.explicacao, c.base_09_09, c.ligado,
         coalesce(u.achados, 0), u.valor, u.detalhe, u.rodado_em,
         case when a.achados is null then null else u.achados - a.achados end
    from public.invariante_config c
    left join ultimos u on u.nome = c.nome
    left join anteriores a on a.nome = c.nome
   where public.usuario_e_gestao()
   order by case c.severidade when 'GRAVE' then 1 when 'ATENCAO' then 2 else 3 end,
            coalesce(u.achados, 0) desc, c.nome;
$$;

revoke all on function public.invariantes_rodar(text)  from public, anon, authenticated;
revoke all on function public.invariantes_painel()     from public, anon, authenticated;
grant  execute on function public.invariantes_painel() to authenticated;

-- O vigia roda sozinho as 06:10 de Brasilia (09:10 UTC): depois que a varredura
-- de nomes fecha (05:58) e antes de a operacao comecar. Se o sistema estiver
-- sob carga, ele pula a rodada -- um alarme nunca derruba o CRM.
select cron.unschedule('vigia_invariantes_diario')
 where exists (select 1 from cron.job where jobname = 'vigia_invariantes_diario');

select cron.schedule(
  'vigia_invariantes_diario', '10 9 * * *',
  $cron$
  do $inner$
  begin
    if public.sistema_sob_carga() then return; end if;
    perform public.invariantes_rodar();
  end
  $inner$;
  $cron$
);
