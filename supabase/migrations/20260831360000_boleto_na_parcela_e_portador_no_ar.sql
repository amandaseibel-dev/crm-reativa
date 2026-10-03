-- O numero do boleto passa a viver na PARCELA, e a coleta de portador volta a rodar.
--
-- Amanda, 31/08: "quando subimos os arquivos de acordo o numero do boleto nao
-- sobe junto?" e "numero do documento e o numero de cada boleto".
--
-- SOBE -- e vai para o lugar errado. A planilha de acordo tem a coluna
-- "Documento"; ImportacaoAcordos.jsx le e `importar_acordos` grava como TITULO
-- (acordos_titulos, tipo_boleto='Acordo'). A PARCELA do acordo, que e onde o
-- pagamento bate, ficava sem numero. Os dois lados existiam em tabelas
-- diferentes, sem ligacao nenhuma.
--
-- A LEITURA DO NUMERO: documento = titulo(6) + parcela(4). Os 4 ultimos digitos
-- sao o numero da parcela. `pagamentos.numero_parcela_completo` e o MESMO
-- numero com um zero a menos na frente.
--
-- MEDIDO EM 31/08: a amarracao por aluno + numero da parcela + valor exato
-- fecha 518 de 528 titulos de acordo (98,1%). Somando os que vieram dos
-- proprios pagamentos, 1.364 parcelas ganharam boleto (11.654 seguem sem).
--
-- O QUE DESTRAVA: dos pagamentos desde julho, 382 casam com parcela ABERTA e
-- valor exato -- R$ 312.825,44 de baixa automatica -- e 513 confirmam parcela
-- ja paga. `pagamentos.operador_nome` existe, entao a baixa credita o operador.
-- A corrente pagamento -> parcela -> acordo -> mensalidades ja fecha inteira em
-- 287 pagamentos / 215 acordos / R$ 755.984,05.
--
-- `importar_acordos` NAO cria parcelas, so titulos -- por isso a amarracao roda
-- DEPOIS da importacao, de hora em hora.

alter table public.parcelas add column if not exists boleto text;
comment on column public.parcelas.boleto is
  'Numero do boleto DESTA parcela: titulo(6) + parcela(4). Chave que casa pagamentos.numero_parcela_completo com a parcela do acordo.';
create unique index if not exists ux_parcelas_boleto on public.parcelas (boleto) where boleto is not null;

create or replace function public.parcelas_amarrar_boleto()
returns jsonb
language plpgsql security definer
set search_path to 'public' set statement_timeout to '300s'
as $function$
declare v_n int := 0;
begin
  with tb as (
    select t.aluno_id, ltrim(t.documento,'0') chave, (right(t.documento,4))::int nr,
           coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) valor
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'')='Acordo' and t.documento ~ '^\d{8,}$'
  ), casado as (
    select distinct on (p.id) p.id parcela_id, tb.chave
      from tb join public.acordos a on a.aluno_id = tb.aluno_id
      join public.parcelas p on p.acordo_id = a.id and p.numero = tb.nr
     where abs(p.valor - tb.valor) <= 0.05 and p.boleto is null
     order by p.id, abs(p.valor - tb.valor)
  ), unico as (
    select c.* from casado c where (select count(*) from casado c2 where c2.chave=c.chave)=1
      and not exists (select 1 from public.parcelas p3 where p3.boleto = c.chave)
  )
  update public.parcelas p set boleto = u.chave, atualizado_em = now()
    from unico u where p.id = u.parcela_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('amarradas_agora', v_n,
    'total_com_boleto', (select count(*) from public.parcelas where boleto is not null),
    'sem_boleto', (select count(*) from public.parcelas where boleto is null));
end;
$function$;
revoke all on function public.parcelas_amarrar_boleto() from public, anon;
grant execute on function public.parcelas_amarrar_boleto() to authenticated, service_role;

-- A coleta de portador NUNCA teve cron -- rodou na mao em 24/08 e parou ali.
-- Nao estava quebrada: chamada agora, respondeu 200 e devolveu o cursor
-- (166 = 26.481 registros na Prime, 195 = 40.507). So ninguem continuava o ciclo.
--
-- A troca de portador e MANUAL: quando a equipe negocia, move o aluno do 195
-- (ReATIVA Recuperacao de Creditos) para o 166 (Santander ReATIVA). Sem as duas
-- listas frescas nao da para saber quem negociou e ninguem trocou.
create or replace function public.prime_portador_mutirao()
returns bigint
language plpgsql security definer
set search_path to 'public'
as $function$
declare v_url text; v_token text; v_req bigint; v_portador int; v_carga jsonb;
begin
  select decrypted_secret into v_url   from vault.decrypted_secrets where name='projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name='prime_cadastro_token';
  if v_url is null or v_token is null then return null; end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then return null; end if;

  select portador into v_portador
    from (select 166 portador union all select 195) p
    left join lateral (select max(coletado_em) ult from public.prime_portador_membro m
                        where m.portador = p.portador) u on true
   order by coalesce(u.ult, timestamptz '2000-01-01') asc limit 1;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
    headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
    body := jsonb_build_object('portador', v_portador),
    timeout_milliseconds := 170000
  ) into v_req;
  return v_req;
end;
$function$;
revoke all on function public.prime_portador_mutirao() from public, anon;
grant execute on function public.prime_portador_mutirao() to service_role;

select cron.schedule('parcelas_amarrar_boleto', '25 * * * *', 'select public.parcelas_amarrar_boleto();');
select cron.schedule('prime_portador_mutirao',  '*/3 * * * *', 'select public.prime_portador_mutirao();');
