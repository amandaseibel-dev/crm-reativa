-- VARREDURA DE NOMES PELO PRIME -- a base inteira, sem ninguem disparar nada.
--
-- POR QUE ELA PRECISA EXISTIR. Em 08/09/2026 descobrimos que fichas do CRM
-- carregavam o NOME ERRADO: a fusao por nome copiava para a ficha o nome de
-- quem teve um titulo grudado nela. Ao pedir ao Prime o nome dos dois lados de
-- 16 pares suspeitos, ele trocou 8. O veredito virou de "7 pessoas diferentes"
-- para 15, e 35 titulos (R$ 17.664,12) voltaram para os donos.
--
-- Medida a contaminacao no primeiro lote de 50 fichas que passaram por fusao:
-- 1 nome trocado, ~2%. Baixa, mas nao zero -- e cada caso e uma pessoa recebendo
-- cobranca de divida que nao e dela, que e problema de LGPD antes de ser de
-- numero.
--
-- POR QUE UMA ROTINA E NAO UM MUTIRAO MANUAL. Sao 17.405 alunos. A Edge Function
-- tem teto de 150s por invocacao e faz ~50 por vez (medido: 50 CPFs = 57s), ou
-- seja ~350 chamadas. Disparar isso a mao ocupa meio dia e quebra se alguem
-- fechar a janela. Uma rotina retoma de onde parou e nao depende de ninguem.
--
-- ORDEM DE PRIORIDADE, do mais provavel para o menos:
--   1. ficha que passou por rotina de fusao   -- e de la que vem o defeito;
--   2. ficha com divida em aberto             -- errar o nome aqui vira cobranca;
--   3. o resto da base.
--
-- A rotina respeita o disjuntor `sistema_sob_carga` -- se o banco estiver
-- sofrendo, ela nao dispara e registra o motivo. E so roda de madrugada.

create table if not exists public.prime_varredura_nome (
  cpf         text primary key,
  enviado_em  timestamptz not null default now(),
  prioridade  smallint
);

alter table public.prime_varredura_nome enable row level security;
alter table public.prime_varredura_nome force row level security;

comment on table public.prime_varredura_nome is
  'Controle da varredura de nomes pelo Prime: um CPF por linha, marcado quando ja foi enviado. Nao guarda dado pessoal alem do CPF.';

-- Quem ainda falta, na ordem de prioridade.
create or replace function public.prime_varredura_nome_pendentes(p_limite integer default 50)
 returns table (cpf text, prioridade smallint)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select c.cpf, c.prioridade
  from (
    select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') as cpf,
           min(case
                 when exists (select 1 from public.casos k
                               where k.aluno_id = a.id and k.caso_atualizado_por ilike 'sistema_fusao%') then 1
                 when (public.aluno_saldo_pendente_detalhe(a.id)->>'total')::numeric > 0.005 then 2
                 else 3
               end)::smallint as prioridade
      from public.alunos a
     where length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       and not exists (select 1 from public.prime_varredura_nome v
                        where v.cpf = lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0'))
     group by 1
  ) c
  order by c.prioridade, c.cpf
  limit greatest(coalesce(p_limite, 50), 1);
$function$;

-- Um lote. Chamada pelo cron; devolve quantos foram enviados.
create or replace function public.prime_varredura_nome_processar(p_lote integer default 50)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_url    text;
  v_token  text;
  v_cpfs   jsonb;
  v_qtd    integer;
  v_carga  jsonb;
begin
  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    insert into public.prime_cadastro_execucoes (origem, observacao)
    values ('varredura_nome', 'nao disparou: falta segredo no Vault');
    return 0;
  end if;

  -- Mesmo disjuntor das outras rotinas: banco sofrendo, ninguem incomoda a Ulbra.
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    insert into public.prime_cadastro_execucoes (origem, observacao)
    values ('varredura_nome', 'nao disparou: sistema sob carga -> ' || v_carga::text);
    return 0;
  end if;

  select jsonb_agg(p.cpf), count(*) into v_cpfs, v_qtd
    from public.prime_varredura_nome_pendentes(p_lote) p;

  if coalesce(v_qtd, 0) = 0 then
    insert into public.prime_cadastro_execucoes (origem, observacao)
    values ('varredura_nome', 'concluida: base inteira ja varrida');
    return 0;
  end if;

  -- O token vai em `x-rotina-token`. Em `Authorization: Bearer` a funcao
  -- responde 403 "restrito a gestao" -- ja custou uma chamada perdida.
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/prime-cadastro',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-rotina-token', v_token),
    body := jsonb_build_object('cpfs', v_cpfs, 'limite', p_lote),
    timeout_milliseconds := 150000
  );

  -- Marca ANTES de saber o resultado, de proposito: se a chamada falhar, o CPF
  -- nao pode voltar ao topo da fila e travar a varredura para sempre. Quem nao
  -- voltou fica registrado em prime_cadastro_sem_retorno pela propria funcao.
  insert into public.prime_varredura_nome (cpf, prioridade)
  select p.cpf, p.prioridade from public.prime_varredura_nome_pendentes(p_lote) p
  on conflict (cpf) do nothing;

  return v_qtd;
end;
$function$;

revoke all on function public.prime_varredura_nome_processar(integer) from public, anon, authenticated;
revoke all on function public.prime_varredura_nome_pendentes(integer)  from public, anon, authenticated;

-- Cron: a cada 2 minutos, so na madrugada (03:00-08:58 UTC = 00:00-05:58 BRT).
-- 50 CPFs por lote, ~30 lotes por hora -> ~1.500/hora -> a base inteira em
-- ~12 horas de janela, ou seja duas madrugadas. Para parar: desative o job.
select cron.schedule('prime_varredura_nome', '*/2 3-8 * * *',
                     $$select public.prime_varredura_nome_processar(50);$$);

-- Os 18 CPFs criados hoje e os 16 conferidos ja foram varridos a mao: entram
-- marcados para a rotina nao gastar viagem com eles.
insert into public.prime_varredura_nome (cpf, prioridade)
select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0'), 1
  from public.alunos a
 where a.id in (select aluno_id from public._backup_fichas_criadas_20260908)
   and length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
on conflict (cpf) do nothing;
