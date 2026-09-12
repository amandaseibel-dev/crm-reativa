-- Opcao B: fila pos-importacao de "aluno com divida e sem ficha".
--
-- Causa-raiz medida em prod 2026-09-11: `Borderos.jsx` grava em `importacoes`,
-- `alunos`, `acordos_titulos`, `acordos` e `parcelas` -- e NAO grava em `casos`.
-- Nenhum dos 17 gatilhos de `alunos` cria ficha. Em 09/09 as 18:12 isso deixou
-- 492 alunos fora de todas as filas. Todo bordero com aluno novo repete.
--
-- A fila fica no banco, e nao no Borderos.jsx, porque cobre TODOS os caminhos
-- de importacao (bordero, acordos, e os que vierem) sem depender de deploy de
-- frontend, e porque uma visao derivada e idempotente por construcao:
-- reprocessar o mesmo arquivo nao muda nada, ja que a visao so lista quem nao
-- tem ficha AGORA.
--
-- NADA AQUI CRIA FICHA. Nenhum cron e criado. Os dois interruptores nascem
-- `false`. Nenhuma atribuicao a operador em etapa nenhuma.

-- 1. A visao derivada. Mostra elegiveis E bloqueados, com o motivo, para a
--    gestao ver quem ficou de fora e por que. Zero escrita.
create or replace view public.vw_alunos_sem_caso_com_divida as
with divida as (
  select al.id as aluno_id,
    coalesce((select sum(p.valor) from public.parcelas p
                join public.acordos a on a.id = p.acordo_id
               where a.aluno_id = al.id
                 and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
                 and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')),0) as divida_parcelas,
    coalesce((select sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
                from public.acordos_titulos t
               where t.aluno_id = al.id
                 and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                 and coalesce(lower(t.status),'') not in ('quitada')
                 and coalesce(t.tipo_boleto,'') <> 'Acordo'
                 and not exists (select 1 from public.acordo_titulo_vinculo v
                                   join public.acordos a2 on a2.id = v.acordo_id
                                  where v.titulo_id = t.id and coalesce(v.ativo,true)
                                    and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA'))),0) as divida_titulos
  from public.alunos al
  where not exists (select 1 from public.casos c where c.aluno_id = al.id)
)
select
  al.id as aluno_id,
  al.nome,
  al.cpf_mascarado,
  nullif(regexp_replace(coalesce(al.cpf_corrigido, al.cpf, ''), '\D', '', 'g'), '') as cpf_digitos,
  al.matricula,
  al.unidade,
  al.curso,
  al.status_atual,
  al.situacao_academica,
  al.created_at as aluno_criado_em,
  round(d.divida_parcelas, 2) as divida_parcelas,
  round(d.divida_titulos, 2)  as divida_titulos,
  round(d.divida_parcelas + d.divida_titulos, 2) as divida_canonica,
  -- filtros de seguranca, explicitos
  (upper(coalesce(al.status_atual,'')||' '||coalesce(al.status_jornada,'')||' '||coalesce(al.situacao_academica,''))
     ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO|CANCELADO') as bloqueado_por_status,
  exists (select 1 from public.alunos a2
            join public.casos c2 on c2.aluno_id = a2.id
           where a2.id <> al.id
             and nullif(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D','','g'),'') is not null
             and lpad(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D','','g'), 11, '0')
               = lpad(regexp_replace(coalesce(al.cpf_corrigido, al.cpf, ''), '\D','','g'), 11, '0')
         ) as cpf_tem_outra_ficha,
  case
    when (d.divida_parcelas + d.divida_titulos) <= 0.005 then 'sem divida canonica'
    when upper(coalesce(al.status_atual,'')||' '||coalesce(al.status_jornada,'')||' '||coalesce(al.situacao_academica,''))
           ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO|CANCELADO' then 'bloqueado por situacao juridica/cancelamento'
    when exists (select 1 from public.alunos a2
                   join public.casos c2 on c2.aluno_id = a2.id
                  where a2.id <> al.id
                    and nullif(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D','','g'),'') is not null
                    and lpad(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D','','g'), 11, '0')
                      = lpad(regexp_replace(coalesce(al.cpf_corrigido, al.cpf, ''), '\D','','g'), 11, '0'))
      then 'CPF ja tem outra ficha -- unificar antes'
    else null
  end as motivo_bloqueio,
  ((d.divida_parcelas + d.divida_titulos) > 0.005
    and not (upper(coalesce(al.status_atual,'')||' '||coalesce(al.status_jornada,'')||' '||coalesce(al.situacao_academica,''))
               ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO|CANCELADO')
    and not exists (select 1 from public.alunos a2
                      join public.casos c2 on c2.aluno_id = a2.id
                     where a2.id <> al.id
                       and nullif(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D','','g'),'') is not null
                       and lpad(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D','','g'), 11, '0')
                         = lpad(regexp_replace(coalesce(al.cpf_corrigido, al.cpf, ''), '\D','','g'), 11, '0'))
  ) as elegivel
from divida d
join public.alunos al on al.id = d.aluno_id;

revoke all on public.vw_alunos_sem_caso_com_divida from anon, authenticated;

comment on view public.vw_alunos_sem_caso_com_divida is
  'Aluno com divida canonica e sem nenhuma ficha em casos. Derivada: nao escreve, idempotente, reprocessar importacao nao altera nada. Traz elegiveis e bloqueados com motivo.';

-- 2. A fila de gestao. Uma linha por aluno, decidida por humano.
create table if not exists public.fila_caso_faltando (
  aluno_id          uuid primary key references public.alunos(id) on delete cascade,
  cpf_digitos       text,
  matricula         text,
  divida_canonica   numeric,
  elegivel          boolean not null default false,
  motivo_bloqueio   text,
  origem            text not null default 'SISTEMA_CASO_FALTANDO',
  origem_importacao_id uuid,
  detectado_em      timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  status            text not null default 'PENDENTE'
                    check (status in ('PENDENTE','FICHA_CRIADA','IGNORADO','BLOQUEADO')),
  decidido_em       timestamptz,
  decidido_por      text,
  caso_id           uuid references public.casos(id) on delete set null,
  observacao        text
);
create index if not exists ix_fila_caso_faltando_pendente
  on public.fila_caso_faltando (detectado_em desc) where status = 'PENDENTE';

alter table public.fila_caso_faltando enable row level security;

comment on table public.fila_caso_faltando is
  'Fila pos-importacao de aluno com divida e sem ficha. Nenhuma rotina cria ficha a partir daqui: os interruptores em fila_caso_faltando_config nascem false e nao existe cron.';

-- 3. Os interruptores. Nascem DESLIGADOS.
create table if not exists public.fila_caso_faltando_config (
  chave       text primary key,
  ligado      boolean not null default false,
  descricao   text,
  alterado_em timestamptz not null default now(),
  alterado_por text
);

insert into public.fila_caso_faltando_config (chave, ligado, descricao) values
  ('enfileirar_automaticamente', false,
   'Se ligado, uma rotina passa a popular a fila sozinha apos importacao. Hoje a fila so e populada quando alguem chama fila_caso_faltando_atualizar().'),
  ('criar_ficha_automaticamente', false,
   'Se ligado, a fila cria a ficha sem passar por decisao humana. Precisa de aprovacao explicita da gestao para ser ligado.'),
  ('atribuir_operador_automaticamente', false,
   'Se ligado, a ficha criada ja sai com operador. Fora de escopo nesta fase: a ficha nasce sem dono.')
on conflict (chave) do nothing;

alter table public.fila_caso_faltando_config enable row level security;

-- 4. Atualizador da fila. Escreve SO na fila, nunca em casos/alunos.
--    Idempotente: uma linha por aluno, refresca os numeros de quem ainda esta
--    pendente e nunca mexe em quem ja foi decidido.
create or replace function public.fila_caso_faltando_atualizar(
  p_importacao_id uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_novos int := 0; v_atualizados int := 0; v_resolvidos int := 0;
begin
  -- quem ja tem ficha sai da fila (resolvido por fora, por exemplo na mao)
  update public.fila_caso_faltando f
     set status = 'FICHA_CRIADA', atualizado_em = now(),
         caso_id = (select c.id from public.casos c where c.aluno_id = f.aluno_id limit 1)
   where f.status = 'PENDENTE'
     and exists (select 1 from public.casos c where c.aluno_id = f.aluno_id);
  get diagnostics v_resolvidos = row_count;

  insert into public.fila_caso_faltando (
    aluno_id, cpf_digitos, matricula, divida_canonica, elegivel, motivo_bloqueio,
    origem_importacao_id, status)
  select v.aluno_id, v.cpf_digitos, v.matricula, v.divida_canonica, v.elegivel, v.motivo_bloqueio,
         p_importacao_id,
         case when v.elegivel then 'PENDENTE' else 'BLOQUEADO' end
    from public.vw_alunos_sem_caso_com_divida v
   where v.divida_canonica > 0.005
  on conflict (aluno_id) do nothing;
  get diagnostics v_novos = row_count;

  -- refresca numeros de quem segue pendente/bloqueado, sem tocar em decidido
  update public.fila_caso_faltando f
     set divida_canonica = v.divida_canonica,
         elegivel        = v.elegivel,
         motivo_bloqueio = v.motivo_bloqueio,
         status          = case when v.elegivel then 'PENDENTE' else 'BLOQUEADO' end,
         atualizado_em   = now()
    from public.vw_alunos_sem_caso_com_divida v
   where v.aluno_id = f.aluno_id
     and f.status in ('PENDENTE','BLOQUEADO')
     and (f.divida_canonica is distinct from v.divida_canonica
          or f.elegivel is distinct from v.elegivel
          or f.motivo_bloqueio is distinct from v.motivo_bloqueio);
  get diagnostics v_atualizados = row_count;

  return jsonb_build_object(
    'novos_na_fila', v_novos,
    'atualizados', v_atualizados,
    'saiu_da_fila_por_ja_ter_ficha', v_resolvidos,
    'pendentes_elegiveis', (select count(*) from public.fila_caso_faltando where status='PENDENTE'),
    'bloqueados', (select count(*) from public.fila_caso_faltando where status='BLOQUEADO'),
    'criacao_automatica_ligada', (select ligado from public.fila_caso_faltando_config where chave='criar_ficha_automaticamente'),
    'em', now());
end;
$fn$;

-- Primeira carga da fila (escreve SO na fila)
select public.fila_caso_faltando_atualizar();
