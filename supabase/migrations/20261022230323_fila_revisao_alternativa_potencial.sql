-- FILA DE REVISAO CADASTRAL: separar quem tem alternativa a CONFERIR de quem
-- precisa de conferencia de titularidade do zero.
--
-- POR QUE. A fila publicada no A7 lista os contatos em conflito e as fichas
-- presas em cada um, mas nao diz o que cada ficha PEDE. Medido em producao em
-- 22/10/2026 sobre os 84 alunos com saldo que ficaram sem canal:
--
--   15 tem outro contato ja cadastrado em `aluno_contatos` que talvez sirva
--       (R$ 32.235,46) -- comecam por conferir esse contato;
--    3 tem contato alternativo, mas ele JA ESTA na ficha de outra pessoa:
--       promover criaria colisao nova, entao vao para conferencia;
--   66 nao tem alternativa nenhuma -- 44 presos em colisao de 2 a 3 pessoas
--       (conferir titularidade) e 22 em colisao de 5+ (erro de cadastro, 6
--       contatos concentram os 22).
--
-- Sem essa separacao o Administrativo descobre caso a caso, abrindo 84 fichas
-- para achar 15.
--
-- "POTENCIAL", NAO "SEGURA" -- e a parte que importa. O dado prova que o
-- contato existe, esta valido, nao e placeholder e nao esta na ficha de mais
-- ninguem. NAO prova que o contato e da pessoa. Ausencia de colisao e ausencia
-- de sinal de problema, nao comprovacao de titularidade. Por isso o campo se
-- chama `alternativa_potencial` e a acao sugerida e CONFERIR_E_PROMOVER: a
-- confirmacao humana do Administrativo continua sendo pre-requisito, nunca
-- etapa opcional.
--
-- SEM EXISTS CORRELACIONADO POR ALUNO. A versao do A7 avaliava, para CADA
-- ficha da fila, um `exists` sobre `vw_contato_normalizado` e outro sobre
-- `vw_contato_bloqueio`. Nesta mesma frente eu ja paguei por esse padrao: na
-- porta 2 das acoes massivas, dois `EXISTS` correlacionados contra
-- `vw_contato_bloqueio` custaram ~1,44 s POR LINHA. Aqui tudo vira CTE
-- materializado e LEFT JOIN: cada view pesada e lida um numero fixo de vezes,
-- independente de quantas fichas a fila tenha.
--
-- NADA DE BLOQUEIO MUDA. Esta funcao e so de LEITURA da fila. Nao entra em
-- `vw_contato_bloqueio`, nao toca o universo das acoes massivas nem nenhuma das
-- 5 funcoes que o A7 alterou por patch ancorado. Se o indicador estiver errado,
-- o pior resultado e o Administrativo abrir uma ficha a toa -- nunca um envio
-- indevido.
--
-- ZERO DML, ZERO GRANT NOVO. O portao `usuario_pode_revalidar_contato()` segue
-- dentro da propria funcao; nenhuma view nova, nenhuma permissao nova, nenhuma
-- acao em massa. A promocao de contato continua sendo clique humano em
-- `aluno_contato_tornar_principal`, e a reativacao segue exclusiva do
-- Administrativo e da supervisao em `aluno_contato_revalidar`.
--
-- POR QUE `create or replace` E NAO PATCH ANCORADO: esta funcao nasceu no A7,
-- o corpo inteiro e conhecido e esta versionado em
-- `20261022120000_a7_contato_compartilhado_bloqueia_massiva.sql`. Patch ancorado
-- existe para nao reescrever funcao legada de centenas de linhas cuja
-- precedencia importa; nao e o caso. O rollback restaura o corpo do A7 na
-- integra.

create or replace function public.contato_fila_revisao(p_canal text default null,
                                                       p_limite integer default 200)
returns table(canal text, contato text, pessoas integer, fichas integer,
              revisao_prioritaria boolean, alunos jsonb)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.usuario_pode_revalidar_contato() then
    raise exception 'Acesso negado: fila de revisao cadastral restrita ao Administrativo e a supervisao.'
      using errcode = '42501';
  end if;

  return query
  with conflito as materialized (
    -- os contatos em conflito, ja no limite e na ordem final
    select s.canal, s.contato, s.pessoas, s.fichas, s.revisao_prioritaria
      from public.vw_contato_compartilhado s
     where p_canal is null or upper(btrim(p_canal)) = s.canal
     order by s.revisao_prioritaria desc, s.pessoas desc, s.canal, s.contato
     limit least(greatest(coalesce(p_limite, 200), 1), 1000)
  ),
  ficha as materialized (
    -- as fichas presas em cada contato em conflito
    select c.canal, c.contato, c.pessoas, c.fichas, c.revisao_prioritaria, n.aluno_id
      from conflito c
      join public.vw_contato_normalizado n
        on n.canal = c.canal and n.contato = c.contato
  ),
  norm as materialized (
    -- o contato que esta NA FICHA de cada aluno em jogo, por canal
    select n.aluno_id, n.canal, n.contato
      from public.vw_contato_normalizado n
     where n.aluno_id in (select f.aluno_id from ficha f)
  ),
  bloq as materialized (
    select b.aluno_id, b.canal
      from public.vw_contato_bloqueio b
     where b.aluno_id in (select f.aluno_id from ficha f)
  ),
  -- (A) canal da FICHA que segue utilizavel: tem contato, nao e placeholder e
  --     nao esta bloqueado. LEFT JOIN, nao `exists` por linha.
  canal_livre as materialized (
    select n.aluno_id, n.canal
      from norm n
      left join bloq b on b.aluno_id = n.aluno_id and b.canal = n.canal
     where n.contato is not null
       and not public.contato_e_placeholder(n.canal, n.contato)
       and b.aluno_id is null
  ),
  -- (B) contatos cadastrados em aluno_contatos, validos, dos alunos em jogo
  alt as materialized (
    select ac.aluno_id,
           case when lower(ac.tipo) = 'telefone' then 'TELEFONE' else 'EMAIL' end as canal,
           case when lower(ac.tipo) = 'telefone' then public.contato_tel_sem_ddi(ac.valor)
                else nullif(lower(btrim(ac.valor)), '') end as contato
      from public.aluno_contatos ac
     where ac.aluno_id in (select f.aluno_id from ficha f)
       and ac.valido is true
       and lower(coalesce(ac.tipo, '')) in ('telefone', 'email')
  ),
  -- (C) em quantas FICHAS cada contato alternativo aparece.
  --     Uma leitura agregada, nao uma por aluno.
  --
  --     `= 0` e a condicao de alternativa potencial, e ela SUBSUME "nao
  --     compartilhado": compartilhamento exige o contato em duas fichas de
  --     pessoas diferentes, logo um contato que nao esta em ficha nenhuma nao
  --     pode estar compartilhado. Por isso nao e preciso ler
  --     `vw_contato_compartilhado` de novo aqui.
  presenca as materialized (
    select n.canal, n.contato, count(*) as fichas_com_o_contato
      from public.vw_contato_normalizado n
     where n.contato is not null
       and (n.canal, n.contato) in (select a.canal, a.contato from alt a where a.contato is not null)
     group by n.canal, n.contato
  ),
  alt_potencial as materialized (
    select distinct a.aluno_id
      from alt a
      left join norm nf on nf.aluno_id = a.aluno_id and nf.canal = a.canal
      left join presenca p on p.canal = a.canal and p.contato = a.contato
     where a.contato is not null
       and not public.contato_e_placeholder(a.canal, a.contato)
       -- diferente do que ja esta na ficha nesse canal
       and a.contato is distinct from nf.contato
       -- e nao esta na ficha de mais ninguem
       and p.contato is null
  )
  select f.canal, f.contato, f.pessoas, f.fichas, f.revisao_prioritaria,
         coalesce(jsonb_agg(jsonb_build_object(
           'aluno_id', f.aluno_id,
           'nome', a.nome,
           -- ja existia: a ficha tem OUTRO canal utilizavel?
           'tem_canal_alternativo', (cl.aluno_id is not null),
           -- novo: existe contato cadastrado que TALVEZ sirva, a conferir
           'alternativa_potencial', (ap.aluno_id is not null),
           'acao_sugerida', case when ap.aluno_id is not null then 'CONFERIR_E_PROMOVER'
                                 else 'CONFERIR_TITULARIDADE' end
         ) order by a.nome), '[]'::jsonb)
    from ficha f
    join public.alunos a on a.id = f.aluno_id
    -- no maximo uma linha: canal_livre tem 1 por (aluno, canal) e o canal do
    -- conflito esta bloqueado, logo nunca aparece aqui
    left join canal_livre cl on cl.aluno_id = f.aluno_id and cl.canal <> f.canal
    left join alt_potencial ap on ap.aluno_id = f.aluno_id
   group by f.canal, f.contato, f.pessoas, f.fichas, f.revisao_prioritaria
   order by f.revisao_prioritaria desc, f.pessoas desc, f.canal, f.contato;
end;
$$;

comment on function public.contato_fila_revisao(text, integer) is
  'A7/fila: contatos compartilhados para revisao cadastral. Administrativo e supervisao apenas. Por ficha devolve alternativa_potencial (contato cadastrado que TALVEZ sirva -- nao e prova de titularidade) e acao_sugerida. Leitura pura: nao altera bloqueio, dado nem auditoria.';

-- O grant ja existia desde o A7 e nao muda. Repetido so para que aplicar esta
-- migration num banco onde a funcao foi recriada por outro caminho nao deixe o
-- EXECUTE de PUBLIC herdado do schema.
revoke all on function public.contato_fila_revisao(text, integer) from public;
grant execute on function public.contato_fila_revisao(text, integer) to authenticated;

-- Guarda de integridade: o portao tem de continuar dentro da funcao, e a funcao
-- NAO pode ter ganhado `exists` correlacionado contra as views pesadas.
do $guarda$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'contato_fila_revisao';

  if position('usuario_pode_revalidar_contato' in v_src) = 0 then
    raise exception 'fila de revisao: o portao de permissao saiu da funcao.';
  end if;
  if position('alternativa_potencial' in v_src) = 0
     or position('acao_sugerida' in v_src) = 0 then
    raise exception 'fila de revisao: os campos novos nao estao no corpo.';
  end if;
  if position('exists (select 1 from public.vw_contato' in lower(v_src)) > 0 then
    raise exception 'fila de revisao: sobrou EXISTS correlacionado contra view pesada.';
  end if;
  if not has_function_privilege('authenticated', 'public.contato_fila_revisao(text,integer)', 'EXECUTE') then
    raise exception 'fila de revisao: authenticated perdeu o EXECUTE e a tela quebraria.';
  end if;
end
$guarda$;
