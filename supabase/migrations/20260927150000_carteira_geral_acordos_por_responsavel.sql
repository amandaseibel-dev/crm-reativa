-- ---------------------------------------------------------------------------
-- Carteira Geral: acordos por RESPONSAVEL DO ACORDO, e remanejamento de acordo
-- independente do dono do caso.
--
-- POR QUE
-- A Carteira Geral inteira responde "de quem e o CASO": a unica comparacao de
-- responsavel em carteira_geral_base e
--   lower(coalesce(c.operador_email,'')) = lower(f.responsavel)
-- Nao ha, em painel, lista ou filtro, nenhuma comparacao com
-- acordos.operador_responsavel_email. Nao era defeito de consulta -- era
-- escopo: a tela nao tinha a nocao de "acordo sob minha responsabilidade".
--
-- MEDIDO em 27/09/2026 para amanda.seibel@aelbra.com.br:
--   casos dela exibidos na tela ("Meu: 11") ......  11  (34 no total, 23 encerrados)
--   ACORDOS sob a responsabilidade dela ..........  753  (699 alunos, R$ 2.683.032,45)
--     ATIVO 653 / QUITADO 82 / CANCELADO 18
--   e onde eles estao, pelo dono do caso:
--     dela ............  27   (11 ATIVO)
--     Olga ............ 127   (119 ATIVO)
--     Carteira Geral ..   0
--     outro operador .. 563   (519 ATIVO)
--     fila livre ......  34   (4 ATIVO)
--     sem caso ........   2
--   726 dos 753 estao em casos de OUTRAS pessoas.
--
-- O QUE ESTA MIGRATION CRIA
--   1. um portao de supressao do gatilho _aluno_segue_dono_do_acordo;
--   2. duas tabelas proprias: carteira_geral_acordo_previas e
--      carteira_geral_acordo_auditoria (UMA LINHA POR ACORDO);
--   3. cinco RPCs: acordos_painel, acordos_listar, acordos_previa,
--      acordos_mover, acordos_desfazer_lote.
--
-- O QUE ELA NAO FAZ
-- Nao move nada. Nao altera titularidade de caso nem de ficha -- ao contrario,
-- o ponto 1 existe justamente para IMPEDIR que mover um acordo arraste o caso.
-- Nao toca parcelas, pagamentos, honorarios (honorarios_percentual,
-- honorarios_valor) nem autoria historica (criado_por_email, criado_por_nome,
-- confirmado_por_email, confirmado_em): o UPDATE do acordo mexe so em
-- operador_responsavel_email/nome e atualizado_em.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

-- PRECONDICAO
--
-- Nao por md5 do corpo: o md5 do gatilho difere entre producao e a bancada de
-- teste (a bancada monta o esqueleto e aplica os mesmos patches, e o texto de
-- partida nao e byte a byte o de producao). Um md5 fixo aqui passaria em
-- producao e reprovaria o CI -- ou pior, seria afrouxado para passar.
--
-- A precondicao de verdade e a ANCORA: internal.patch_funcao_ancorada exige o
-- trecho no numero exato de ocorrencias e falha alto se nao bater. O que se
-- confere aqui e a ORDEM: o guarda da Carteira Geral, que 20260925181823
-- instalou, tem de estar presente -- senao esta migration estaria rodando
-- antes dela.
do $pre$
begin
  if not exists (select 1 from pg_proc
                  where oid = 'public._aluno_segue_dono_do_acordo()'::regprocedure) then
    raise exception '_aluno_segue_dono_do_acordo nao existe.';
  end if;

  if exists (select 1 from pg_proc
              where oid = 'public._aluno_segue_dono_do_acordo()'::regprocedure
                and prosrc like '%reativa.remanejando_acordo%') then
    raise notice 'ja aplicada: o gatilho ja tem o portao de supressao.';
  elsif not exists (select 1 from pg_proc
                     where oid = 'public._aluno_segue_dono_do_acordo()'::regprocedure
                       and prosrc like '%carteira_geral_email()%') then
    raise exception 'o gatilho nao tem o guarda da Carteira Geral -- aplique 20260925181823 antes desta.';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------------
-- 1) PORTAO DE SUPRESSAO
--
-- trg_aluno_segue_dono_do_acordo e AFTER INSERT OR UPDATE OF
-- operador_responsavel_email, status ON acordos. Ou seja: mover o responsavel
-- de um acordo DISPARA o realinhamento da ficha -- e, atras dela, do caso.
-- Para um acordo ATIVO, destino operador ativo e aluno sem mensalidade em
-- aberto, mover o acordo levaria o caso junto, sem ninguem ter decidido isso.
--
-- O portao e um GUC TRANSACIONAL (set_config(..., true)): vale so dentro da
-- transacao que o ligou, e some no fim dela. Nao e "desligar o gatilho": o
-- gatilho continua ativo para todo o resto do sistema.
-- ---------------------------------------------------------------------------
select internal.patch_funcao_ancorada(
  'public', '_aluno_segue_dono_do_acordo',
$ancora$begin
  if nullif(trim(coalesce(new.operador_responsavel_email,'')),'') is null then return new; end if;$ancora$,
$novo$begin
  -- Remanejamento de ACORDO em curso: quem move o acordo decidiu mover SO o
  -- acordo. A ficha e o caso ficam onde estao -- e a propria funcao que move
  -- confere isso depois, comparando o antes e o depois.
  if coalesce(current_setting('reativa.remanejando_acordo', true), '') = '1' then
    return new;
  end if;

  if nullif(trim(coalesce(new.operador_responsavel_email,'')),'') is null then return new; end if;$novo$,
  1);

-- ---------------------------------------------------------------------------
-- 2) TABELAS PROPRIAS
--
-- Separadas das de caso de proposito: um lote de acordo nao e um lote de caso,
-- e misturar os dois faria o desfazer de um enxergar o outro.
-- ---------------------------------------------------------------------------
create table if not exists public.carteira_geral_acordo_previas (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  criado_por_email text not null,
  filtros jsonb not null default '{}'::jsonb,
  destino_email text,
  destino_nome text,
  itens jsonb not null default '[]'::jsonb,
  total_acordos int not null default 0,
  total_valor numeric not null default 0,
  total_em_caso_de_outro int not null default 0,
  conflitos jsonb not null default '[]'::jsonb,
  executada_em timestamptz,
  executada_por_email text,
  expira_em timestamptz not null default now() + interval '2 hours'
);

create table if not exists public.carteira_geral_acordo_auditoria (
  id uuid primary key default gen_random_uuid(),
  previa_id uuid,
  lote_id uuid not null,
  registrado_em timestamptz not null default now(),
  autor_email text not null,
  autor_nome text,
  motivo text,
  acordo_id uuid not null,
  aluno_id uuid,
  nome_aluno text,
  numero_acordo text,
  status_no_lote text,
  valor_total numeric,
  de_email text,
  para_email text,
  -- fotografia do que NAO foi movido, para o desfazer poder provar
  caso_id uuid,
  caso_dono_email text,
  aluno_resp_email text,
  desfeito_em timestamptz,
  desfeito_por_email text
);

create index if not exists ix_cg_acordo_aud_lote   on public.carteira_geral_acordo_auditoria (lote_id);
create index if not exists ix_cg_acordo_aud_acordo on public.carteira_geral_acordo_auditoria (acordo_id);

alter table public.carteira_geral_acordo_previas   enable row level security;
alter table public.carteira_geral_acordo_auditoria enable row level security;
revoke all on public.carteira_geral_acordo_previas   from public, anon, authenticated;
revoke all on public.carteira_geral_acordo_auditoria from public, anon, authenticated;
grant all on public.carteira_geral_acordo_previas   to service_role;
grant all on public.carteira_geral_acordo_auditoria to service_role;

-- auditoria e append-only, como a de caso
drop trigger if exists trg_cg_acordo_auditoria_append_only on public.carteira_geral_acordo_auditoria;
create trigger trg_cg_acordo_auditoria_append_only
  before delete on public.carteira_geral_acordo_auditoria
  for each row execute function public.carteira_geral_auditoria_append_only();

-- ---------------------------------------------------------------------------
-- 3) BASE: acordos por responsavel, com o DONO DO CASO ao lado.
--
-- A classe do dono do caso e o que impede confundir as duas titularidades:
-- EU / CARTEIRA_GERAL / FILA_LIVRE / SEM_CASO / OUTRO.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_acordos_base(p_filtros jsonb default '{}'::jsonb)
returns table(
  acordo_id uuid, aluno_id uuid, nome text, matricula text,
  numero_acordo text, status text, valor numeric,
  de_email text, de_nome text,
  caso_id uuid, caso_dono_email text, caso_dono_nome text, caso_dono_classe text,
  caso_encerrado boolean
)
language sql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
  with f as (
    select lower(nullif(btrim(coalesce(p_filtros->>'responsavel','')),''))    as responsavel,
           upper(nullif(btrim(coalesce(p_filtros->>'status','')),''))         as status,
           upper(nullif(btrim(coalesce(p_filtros->>'classe_caso','')),''))    as classe_caso,
           nullif(btrim(coalesce(p_filtros->>'busca','')),'')                 as busca
  ),
  -- UM caso por aluno: o nao encerrado vem primeiro. E o mesmo criterio que a
  -- leitura de 27/09 usou, para os numeros baterem.
  caso_do_aluno as (
    select distinct on (c.aluno_id)
           c.aluno_id, c.id as caso_id,
           lower(nullif(btrim(coalesce(c.operador_email,'')),'')) as dono_email,
           c.operador_nome as dono_nome,
           coalesce(c.encerrado_operacional,false) as encerrado
      from public.casos c
     order by c.aluno_id, coalesce(c.encerrado_operacional,false), c.id
  )
  select a.id, a.aluno_id,
         coalesce(al.nome, '(sem ficha)'),
         (select c2.matricula from public.casos c2 where c2.aluno_id = a.aluno_id and c2.matricula is not null limit 1),
         a.numero_acordo::text,
         upper(coalesce(a.status,'')),
         round(coalesce(a.valor_total,0),2),
         lower(coalesce(a.operador_responsavel_email,'')),
         a.operador_responsavel_nome,
         cd.caso_id, cd.dono_email,
         coalesce(u2.nome, cd.dono_nome),
         case
           when cd.caso_id is null                              then 'SEM_CASO'
           when cd.dono_email is null                           then 'FILA_LIVRE'
           when cd.dono_email = internal.carteira_geral_email()  then 'CARTEIRA_GERAL'
           when cd.dono_email = (select responsavel from f)      then 'EU'
           else 'OUTRO'
         end,
         cd.encerrado
    from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
    left join caso_do_aluno cd on cd.aluno_id = a.aluno_id
    left join public.usuarios u2 on lower(u2.email) = cd.dono_email
   cross join f
   where lower(coalesce(a.operador_responsavel_email,'')) = f.responsavel
     and (f.status is null or f.status = 'TODOS' or upper(coalesce(a.status,'')) = f.status)
     and (f.classe_caso is null or f.classe_caso = 'TODOS' or f.classe_caso =
            case
              when cd.caso_id is null                             then 'SEM_CASO'
              when cd.dono_email is null                          then 'FILA_LIVRE'
              when cd.dono_email = internal.carteira_geral_email() then 'CARTEIRA_GERAL'
              when cd.dono_email = f.responsavel                  then 'EU'
              else 'OUTRO'
            end)
     and (f.busca is null
          or coalesce(al.nome,'') ilike '%'||f.busca||'%'
          or coalesce(a.numero_acordo::text,'') ilike '%'||f.busca||'%');
$fn$;

-- ---------------------------------------------------------------------------
-- 4) PAINEL e LISTA
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_acordos_painel(p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb; v_f jsonb;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver acordos por responsavel.' using errcode = '42501';
  end if;

  -- sem responsavel explicito, o padrao e QUEM ESTA PEDINDO ("Meus acordos")
  v_f := coalesce(p_filtros,'{}'::jsonb);
  if nullif(btrim(coalesce(v_f->>'responsavel','')),'') is null then
    v_f := v_f || jsonb_build_object('responsavel', lower(coalesce(auth.jwt()->>'email','')));
  end if;

  -- o painel conta o universo do RESPONSAVEL, sem o recorte de status/classe:
  -- os contadores por status sao justamente o que a pessoa usa para escolher.
  select jsonb_build_object(
    'responsavel', v_f->>'responsavel',
    'total_acordos', count(*),
    'total_valor',   round(coalesce(sum(valor),0),2),
    'alunos',        count(distinct aluno_id),
    'por_status', (
      select coalesce(jsonb_agg(jsonb_build_object('status', s, 'acordos', n, 'valor', v) order by s), '[]'::jsonb)
        from (select status s, count(*) n, round(coalesce(sum(valor),0),2) v
                from public.carteira_geral_acordos_base(v_f - 'status' - 'classe_caso' || '{"status":"TODOS","classe_caso":"TODOS"}'::jsonb)
               group by status) z),
    'por_dono_do_caso', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'classe', c, 'acordos', n, 'valor', v, 'ativos', a) order by c), '[]'::jsonb)
        from (select caso_dono_classe c, count(*) n, round(coalesce(sum(valor),0),2) v,
                     count(*) filter (where status='ATIVO') a
                from public.carteira_geral_acordos_base(v_f - 'status' - 'classe_caso' || '{"status":"TODOS","classe_caso":"TODOS"}'::jsonb)
               group by caso_dono_classe) z),
    -- o numero que a tela contrapoe ao "Meu: N" de casos
    'em_caso_de_outro', (
      select count(*) from public.carteira_geral_acordos_base(
               v_f - 'status' - 'classe_caso' || '{"status":"TODOS","classe_caso":"TODOS"}'::jsonb)
       where caso_dono_classe <> 'EU')
  ) into v_res
  from public.carteira_geral_acordos_base(
         v_f - 'status' - 'classe_caso' || '{"status":"TODOS","classe_caso":"TODOS"}'::jsonb);

  return v_res;
end;
$fn$;

create or replace function public.carteira_geral_acordos_listar(
  p_filtros jsonb default '{}'::jsonb, p_limite int default 200, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb; v_f jsonb;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver acordos por responsavel.' using errcode = '42501';
  end if;

  v_f := coalesce(p_filtros,'{}'::jsonb);
  if nullif(btrim(coalesce(v_f->>'responsavel','')),'') is null then
    v_f := v_f || jsonb_build_object('responsavel', lower(coalesce(auth.jwt()->>'email','')));
  end if;
  if nullif(btrim(coalesce(v_f->>'status','')),'') is null then
    v_f := v_f || '{"status":"ATIVO"}'::jsonb;   -- padrao: a carteira viva
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.valor desc), '[]'::jsonb)
    into v_res
    from (select * from public.carteira_geral_acordos_base(v_f)
           order by valor desc
           limit greatest(coalesce(p_limite,200),1)
          offset greatest(coalesce(p_offset,0),0)) t;

  return v_res;
end;
$fn$;

-- Quem TEM acordo. Nao sai de `usuarios` filtrado por ativo/operador: a Olga
-- esta inativa e responde por 127 acordos, e a gestao nao tem perfil
-- "operador". Listar so operador ativo tornaria essas carteiras inalcancaveis
-- pela tela -- foi exatamente o defeito corrigido no PR #531 para os casos.
create or replace function public.carteira_geral_acordos_responsaveis()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver acordos por responsavel.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'email', email, 'nome', nome, 'acordos', n, 'ativos', ativos,
           'ativo', coalesce(u_ativo,false), 'existe_em_usuarios', u_existe
         ) order by n desc), '[]'::jsonb)
    into v_res
    from (
      select lower(a.operador_responsavel_email) as email,
             coalesce(u.nome, lower(a.operador_responsavel_email)) as nome,
             count(*) as n,
             count(*) filter (where upper(coalesce(a.status,'')) = 'ATIVO') as ativos,
             bool_or(u.ativo) as u_ativo,
             bool_or(u.email is not null) as u_existe
        from public.acordos a
        left join public.usuarios u on lower(u.email) = lower(a.operador_responsavel_email)
       where nullif(btrim(coalesce(a.operador_responsavel_email,'')),'') is not null
       group by 1, 2) z;

  return v_res;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5) PREVIA do remanejamento de ACORDO
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_acordos_previa(
  p_acordo_ids uuid[], p_destino_email text, p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_destino text := lower(btrim(coalesce(p_destino_email,'')));
  v_destino_nome text;
  v_itens jsonb; v_conflitos jsonb; v_id uuid; v_res jsonb;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar acordos.' using errcode = '42501';
  end if;
  if p_acordo_ids is null or array_length(p_acordo_ids,1) is null then
    raise exception 'Nenhum acordo selecionado.';
  end if;

  if v_destino = internal.carteira_geral_email() then
    v_destino_nome := 'CARTEIRA GERAL';
  else
    select u.nome into v_destino_nome from public.usuarios u
     where lower(u.email) = v_destino and u.ativo and u.perfil = 'operador';
    if v_destino_nome is null then
      raise exception 'Destino invalido ou operador inativo: %', p_destino_email;
    end if;
  end if;

  -- fotografia: o acordo E o dono do caso/ficha que NAO se movem
  select coalesce(jsonb_agg(to_jsonb(t) order by t.valor desc), '[]'::jsonb) into v_itens
    from (
      select a.id as acordo_id, a.aluno_id,
             coalesce(al.nome,'(sem ficha)') as nome,
             a.numero_acordo::text as numero,
             upper(coalesce(a.status,'')) as status,
             round(coalesce(a.valor_total,0),2) as valor,
             lower(coalesce(a.operador_responsavel_email,'')) as de_email,
             c.id as caso_id,
             lower(nullif(btrim(coalesce(c.operador_email,'')),'')) as caso_dono_email,
             lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),'')) as aluno_resp_email
        from public.acordos a
        left join public.alunos al on al.id = a.aluno_id
        left join lateral (
          select c2.* from public.casos c2 where c2.aluno_id = a.aluno_id
           order by coalesce(c2.encerrado_operacional,false), c2.id limit 1) c on true
       where a.id = any(p_acordo_ids)
    ) t;

  -- Um conflito POR ACORDO cujo caso fica com outra pessoa. Nunca agregado:
  -- e exatamente o que a gestao tem de ler antes de confirmar.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_conflitos from (
    select jsonb_build_object(
             'tipo', case when it->>'caso_dono_email' is null then 'CASO_FICA_NA_FILA_LIVRE'
                          else 'CASO_FICA_COM_OUTRO' end,
             'acordo_id', it->>'acordo_id', 'nome', it->>'nome', 'numero', it->>'numero',
             'detalhe', 'O acordo '||coalesce(nullif(it->>'numero',''),it->>'acordo_id')||
                        ' passa para '||coalesce(v_destino_nome,'-')||
                        ', mas o CASO e a FICHA de '||(it->>'nome')||' continuam com '||
                        coalesce(nullif(it->>'caso_dono_email',''),'a fila livre')||
                        '. Isto NAO muda de quem e o aluno.') as x
      from jsonb_array_elements(v_itens) it
     where coalesce(it->>'caso_dono_email','') is distinct from v_destino
    union all
    select jsonb_build_object(
             'tipo', 'ACORDO_NAO_ATIVO',
             'acordo_id', it->>'acordo_id', 'nome', it->>'nome', 'numero', it->>'numero',
             'detalhe', 'O acordo esta '||(it->>'status')||'. Mover o responsavel nao altera '||
                        'parcelas, pagamentos nem honorarios.')
      from jsonb_array_elements(v_itens) it
     where (it->>'status') <> 'ATIVO'
  ) z;

  insert into public.carteira_geral_acordo_previas
    (criado_por_email, filtros, destino_email, destino_nome, itens,
     total_acordos, total_valor, total_em_caso_de_outro, conflitos)
  values
    (v_autor, coalesce(p_filtros,'{}'::jsonb),
     case when v_destino = '' then null else v_destino end, v_destino_nome, v_itens,
     jsonb_array_length(v_itens),
     (select coalesce(sum((it->>'valor')::numeric),0) from jsonb_array_elements(v_itens) it),
     (select count(*)::int from jsonb_array_elements(v_itens) it
       where coalesce(it->>'caso_dono_email','') is distinct from v_destino),
     v_conflitos)
  returning id into v_id;

  select jsonb_build_object(
    'previa_id', v_id,
    'destino_email', v_destino,
    'destino_nome', v_destino_nome,
    'total_acordos', jsonb_array_length(v_itens),
    'total_valor', (select coalesce(sum((it->>'valor')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_em_caso_de_outro', (select count(*)::int from jsonb_array_elements(v_itens) it
                                where coalesce(it->>'caso_dono_email','') is distinct from v_destino),
    'itens', v_itens,
    'conflitos', v_conflitos
  ) into v_res;

  return v_res;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6) MOVER: so o acordo. Caso e ficha ficam, e isso e CONFERIDO depois.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_acordos_mover(p_previa_id uuid, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
set statement_timeout to '300s'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := nullif(btrim(coalesce(p_motivo,'')),'');
  v_p public.carteira_geral_acordo_previas;
  v_lote uuid := gen_random_uuid();
  it jsonb;
  v_email_agora text; v_status_agora text;
  v_caso_depois text; v_ficha_depois text;
  v_n int := 0; v_recusados jsonb := '[]'::jsonb;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar acordos.' using errcode = '42501';
  end if;
  if v_motivo is null then
    raise exception 'Informe o motivo do remanejamento.' using errcode = '22023';
  end if;

  select * into v_p from public.carteira_geral_acordo_previas where id = p_previa_id for update;
  if not found then raise exception 'Previa nao encontrada.'; end if;
  if v_p.executada_em is not null then
    raise exception 'Esta previa ja foi executada em %.', v_p.executada_em;
  end if;
  if now() > v_p.expira_em then
    raise exception 'Previa expirada (gerada em %). Gere uma nova.', v_p.criado_em;
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  -- LIGA o portao: o gatilho do acordo nao vai arrastar ficha nem caso.
  perform set_config('reativa.remanejando_acordo', '1', true);

  for it in select e.value from jsonb_array_elements(v_p.itens) e loop
    -- revalida RESPONSAVEL e STATUS: um acordo que mudou de mao ou virou
    -- QUITADO/CANCELADO depois da previa nao e mais o mesmo objeto.
    select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
      into v_email_agora, v_status_agora
      from public.acordos a where a.id = (it->>'acordo_id')::uuid;

    if not found then
      v_recusados := v_recusados || jsonb_build_object(
        'acordo_id', it->>'acordo_id', 'numero', it->>'numero', 'nome', it->>'nome',
        'motivo', 'o acordo nao existe mais');
      continue;
    end if;
    if v_email_agora is distinct from coalesce(it->>'de_email','') then
      v_recusados := v_recusados || jsonb_build_object(
        'acordo_id', it->>'acordo_id', 'numero', it->>'numero', 'nome', it->>'nome',
        'motivo', 'o responsavel mudou depois da previa (previa: '||
                  coalesce(nullif(it->>'de_email',''),'ninguem')||', agora: '||
                  coalesce(nullif(v_email_agora,''),'ninguem')||')');
      continue;
    end if;
    if v_status_agora is distinct from coalesce(it->>'status','') then
      v_recusados := v_recusados || jsonb_build_object(
        'acordo_id', it->>'acordo_id', 'numero', it->>'numero', 'nome', it->>'nome',
        'motivo', 'o status mudou depois da previa ('||coalesce(it->>'status','-')||
                  ' -> '||coalesce(v_status_agora,'-')||')');
      continue;
    end if;

    -- Troca so o responsavel. set_resp_acordo mexe em
    -- operador_responsavel_email e atualizado_em, e registra a movimentacao;
    -- parcelas, pagamentos, honorarios e autoria historica nao sao tocados.
    perform internal.set_resp_acordo(
      (it->>'acordo_id')::uuid, v_p.destino_email, v_p.destino_nome,
      'CARTEIRA_GERAL_ACORDO_REMANEJADO',
      'Remanejamento de ACORDO -> '||coalesce(v_p.destino_nome,'fila livre')||
      '. O caso e a ficha NAO foram movidos. Motivo: '||v_motivo||'. Lote: '||v_lote::text,
      v_autor, coalesce(v_autor_nome, v_autor));

    -- o nome do responsavel nao entra no gatilho (ele e AFTER UPDATE OF
    -- operador_responsavel_email, status), entao isto nao dispara nada
    update public.acordos
       set operador_responsavel_nome = v_p.destino_nome
     where id = (it->>'acordo_id')::uuid;

    -- PROVA de que o portao funcionou: caso e ficha tem de estar como na previa
    select lower(nullif(btrim(coalesce(c.operador_email,'')),''))
      into v_caso_depois from public.casos c where c.id = nullif(it->>'caso_id','')::uuid;
    select lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
      into v_ficha_depois from public.alunos al where al.id = (it->>'aluno_id')::uuid;

    if v_caso_depois is distinct from nullif(it->>'caso_dono_email','')
       or v_ficha_depois is distinct from nullif(it->>'aluno_resp_email','') then
      raise exception
        'ABORTADO: mover o acordo % mudou o dono do caso ou da ficha (caso: % -> %, ficha: % -> %). Nada foi gravado.',
        coalesce(nullif(it->>'numero',''), it->>'acordo_id'),
        coalesce(nullif(it->>'caso_dono_email',''),'ninguem'), coalesce(v_caso_depois,'ninguem'),
        coalesce(nullif(it->>'aluno_resp_email',''),'ninguem'), coalesce(v_ficha_depois,'ninguem');
    end if;

    insert into public.carteira_geral_acordo_auditoria
      (previa_id, lote_id, autor_email, autor_nome, motivo,
       acordo_id, aluno_id, nome_aluno, numero_acordo, status_no_lote, valor_total,
       de_email, para_email, caso_id, caso_dono_email, aluno_resp_email)
    values
      (p_previa_id, v_lote, v_autor, v_autor_nome, v_motivo,
       (it->>'acordo_id')::uuid, (it->>'aluno_id')::uuid, it->>'nome',
       it->>'numero', it->>'status', coalesce((it->>'valor')::numeric,0),
       nullif(it->>'de_email',''), v_p.destino_email,
       nullif(it->>'caso_id','')::uuid, nullif(it->>'caso_dono_email',''),
       nullif(it->>'aluno_resp_email',''));

    v_n := v_n + 1;
  end loop;

  perform set_config('reativa.remanejando_acordo', '0', true);

  update public.carteira_geral_acordo_previas
     set executada_em = now(), executada_por_email = v_autor
   where id = p_previa_id;

  return jsonb_build_object(
    'ok', true, 'lote_id', v_lote, 'previa_id', p_previa_id,
    'destino_email', v_p.destino_email, 'destino_nome', v_p.destino_nome,
    'acordos_movidos', v_n,
    'casos_movidos', 0, 'fichas_movidas', 0,
    'recusados', v_recusados,
    'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7) DESFAZER: recusa o acordo que mudou depois do lote.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_acordos_desfazer_lote(
  p_lote_id uuid, p_motivo text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
set statement_timeout to '300s'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := coalesce(nullif(btrim(coalesce(p_motivo,'')),''), 'Desfazer remanejamento de acordo');
  r record;
  v_email_agora text; v_status_agora text; v_bloqueio text;
  v_n int := 0; v_recusados jsonb := '[]'::jsonb;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para desfazer remanejamento de acordos.' using errcode = '42501';
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  perform set_config('reativa.remanejando_acordo', '1', true);

  for r in select * from public.carteira_geral_acordo_auditoria
            where lote_id = p_lote_id and desfeito_em is null
            order by registrado_em
  loop
    v_bloqueio := null;

    select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
      into v_email_agora, v_status_agora
      from public.acordos a where a.id = r.acordo_id;

    if not found then
      v_bloqueio := 'o acordo nao existe mais';
    elsif v_email_agora is distinct from lower(coalesce(r.para_email,'')) then
      v_bloqueio := 'o responsavel mudou depois do lote (agora: '||
                    coalesce(nullif(v_email_agora,''),'ninguem')||') -- desfazer apagaria esse trabalho';
    elsif v_status_agora is distinct from upper(coalesce(r.status_no_lote,'')) then
      v_bloqueio := 'o status mudou depois do lote ('||coalesce(r.status_no_lote,'-')||
                    ' -> '||coalesce(v_status_agora,'-')||')';
    end if;

    if v_bloqueio is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'acordo_id', r.acordo_id, 'numero', r.numero_acordo, 'nome', r.nome_aluno,
        'motivo', v_bloqueio);
      continue;
    end if;

    perform internal.set_resp_acordo(
      r.acordo_id, r.de_email,
      (select coalesce(u.nome, r.de_email) from public.usuarios u where lower(u.email) = lower(r.de_email)),
      'CARTEIRA_GERAL_ACORDO_DESFEITO',
      'Desfeito o lote de acordos '||p_lote_id::text||'. Motivo: '||v_motivo||'.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.acordos
       set operador_responsavel_nome =
             (select coalesce(u.nome, r.de_email) from public.usuarios u where lower(u.email) = lower(r.de_email))
     where id = r.acordo_id;

    update public.carteira_geral_acordo_auditoria
       set desfeito_em = now(), desfeito_por_email = v_autor
     where id = r.id;

    v_n := v_n + 1;
  end loop;

  perform set_config('reativa.remanejando_acordo', '0', true);

  return jsonb_build_object('ok', true, 'lote_id', p_lote_id,
                            'acordos_devolvidos', v_n,
                            'recusados', v_recusados,
                            'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ACL: portao INTERNO em cada funcao, nunca revoke de authenticated.
-- ---------------------------------------------------------------------------
do $acl$
declare f text;
begin
  foreach f in array array[
    'public.carteira_geral_acordos_responsaveis()',
    'public.carteira_geral_acordos_painel(jsonb)',
    'public.carteira_geral_acordos_listar(jsonb,integer,integer)',
    'public.carteira_geral_acordos_previa(uuid[],text,jsonb)',
    'public.carteira_geral_acordos_mover(uuid,text)',
    'public.carteira_geral_acordos_desfazer_lote(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- a base e peca interna: so as RPCs acima a chamam
  revoke all on function public.carteira_geral_acordos_base(jsonb) from public, anon, authenticated;
  grant execute on function public.carteira_geral_acordos_base(jsonb) to service_role;
end
$acl$;
