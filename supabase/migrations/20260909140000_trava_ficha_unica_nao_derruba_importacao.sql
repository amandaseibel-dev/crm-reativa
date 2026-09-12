-- A TRAVA NAO PODE DERRUBAR O LOTE.
--
-- 09/09 11:24: a importacao da projecao morreu inteira com
-- "ALUNO_JA_TEM_CASO_ABERTO: Francisco Argenta". A trava estava certa -- ele
-- tem duas fichas desde 29/06, uma encerrada e uma aberta, e a importacao
-- tentou REABRIR a encerrada. Errado era o efeito: uma ficha matava o lote.
--
-- Mesmo defeito que o cron casos_reabrir_com_divida tinha e que ja corrigimos:
-- guarda que aborta em vez de pular. Sao 484 fichas encerradas dividindo o
-- aluno com uma ficha aberta (471 alunos) -- isso ia se repetir todo dia.
--
-- REGRA NOVA, por operacao:
--   INSERT  -> continua levantando erro. Ficha nova duplicada e recusada alto.
--   UPDATE que REABRE uma ficha ja encerrada, tendo o aluno outra ficha aberta
--           -> a ficha CONTINUA encerrada e o caso fica registrado. O lote
--              segue. Nada e apagado; a divida esta na ficha aberta do aluno,
--              que e onde o operador trabalha.
--
-- Nada disso e silencioso: cada barrada vira linha em ficha_reabertura_barrada
-- e o vigia conta todo dia (checagem reabertura_de_ficha_barrada).

create table if not exists public.ficha_reabertura_barrada (
  id            bigserial primary key,
  caso_id       uuid not null,
  caso_codigo   integer,
  aluno_id      uuid not null,
  outro_caso_id uuid,
  outro_codigo  integer,
  nome          text,
  em            timestamptz not null default now()
);

create index if not exists ix_ficha_reabertura_barrada_em
  on public.ficha_reabertura_barrada (em desc);

alter table public.ficha_reabertura_barrada enable row level security;

drop policy if exists ficha_reabertura_barrada_gestao_le on public.ficha_reabertura_barrada;
create policy ficha_reabertura_barrada_gestao_le on public.ficha_reabertura_barrada
  for select using (public.usuario_e_gestao());

comment on table public.ficha_reabertura_barrada is
  'Reaberturas que a trava de ficha unica segurou. Registro, nao lixeira: a ficha continua encerrada e a divida esta na ficha aberta do aluno.';

create or replace function public._caso_nao_duplica_aluno()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_outro_id     uuid;
  v_outro_codigo integer;
  v_nome         text;
begin
  if new.aluno_id is null then return new; end if;
  if coalesce(new.encerrado_operacional, false) then return new; end if;
  if public.caso_encerrado_operacional(new.cpf, new.status_atual, new.status_acionamento,
                                       new.status_financeiro, new.status_jornada) then
    return new;
  end if;

  select c.id, c.caso_codigo into v_outro_id, v_outro_codigo
    from public.casos c
   where c.aluno_id = new.aluno_id
     and c.id <> new.id
     and not coalesce(c.encerrado_operacional, false)
     and public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada) = false
   limit 1;

  if v_outro_id is null then return new; end if;

  select coalesce(nullif(btrim(a.nome), ''), '(sem nome)') into v_nome
    from public.alunos a where a.id = new.aluno_id;

  -- REABERTURA: a ficha ja estava encerrada e alguem (importacao, rotina) esta
  -- acordando ela enquanto o aluno tem outra ficha aberta. Nao derruba o lote:
  -- mantem encerrada e registra. So vale no gatilho BEFORE, onde ainda da para
  -- mudar a linha; o AFTER, ao ver encerrado_operacional = true, sai na 1a linha.
  if tg_op = 'UPDATE'
     and coalesce(old.encerrado_operacional, false)
     and tg_when = 'BEFORE' then
    new.encerrado_operacional := true;

    insert into public.ficha_reabertura_barrada
      (caso_id, caso_codigo, aluno_id, outro_caso_id, outro_codigo, nome)
    values (new.id, new.caso_codigo, new.aluno_id, v_outro_id, v_outro_codigo, v_nome);

    return new;
  end if;

  -- FICHA NOVA duplicada: continua sendo erro, e alto.
  raise exception
    'ALUNO_JA_TEM_CASO_ABERTO: % ja esta na fila no caso %. A ficha do aluno e unica -- um CPF, uma ficha. Abra o caso existente e trabalhe nele; se sao dois cursos, isso e um campo na ficha, nao uma segunda ficha.',
    coalesce(v_nome, new.aluno_id::text),
    coalesce(v_outro_codigo::text, left(v_outro_id::text, 8));
end;
$function$;

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('reabertura_de_ficha_barrada','ATENCAO','Reabertura de ficha segurada pela trava',
  'A importacao ou uma rotina tentou reabrir uma ficha encerrada de um aluno que ja tem outra ficha aberta. A trava manteve encerrada e o lote seguiu. Numero alto significa que a origem esta acordando a ficha errada.','0 (a checagem nasce em 09/09)')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo,
      explicacao = excluded.explicacao;
