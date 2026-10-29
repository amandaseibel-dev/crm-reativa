-- Mesclar cadastro duplicado -- movendo tudo, sem apagar nada.
--
-- Amanda, 27/08/2026: "precisamos tirar esses cadastros duplicados da nossa
-- base".
--
-- POR QUE NAO APAGAR. `aluno_id` aparece em ~35 tabelas vivas: divida, acordos,
-- casos, movimentacoes, pagamentos, baixas, links, termos, notificacoes,
-- conversas de WhatsApp, auditorias. Apagar o cadastro deixa tudo isso orfao --
-- foi exatamente o que produziu os 761 casos sem aluno que quebraram a lista do
-- Diego hoje (ver 20260827220000 e 20260827230000). Aqui nada e apagado: o
-- conteudo do duplicado E MOVIDO para o cadastro que fica, e o duplicado e
-- MARCADO com status_jornada = CADASTRO_DUPLICADO.
--
-- SIMULACAO POR PADRAO. p_dry_run comeca em true: devolve o que MOVERIA sem
-- tocar em nada. So com p_dry_run => false executa.
--
-- SO MESMO CPF. Nome igual nao basta. Hoje, ao religar casos orfaos, completar
-- CPF com zeros fez "Jonathan de Melo Rodrigues" bater com "Kamila Bruce
-- Araujo" -- pessoas diferentes. Dos 116 nomes repetidos da base, o Prime
-- confirma que 94 sao homonimos de verdade. Mesclar por nome teria juntado
-- divida de gente que nao se conhece.
--
-- O QUE FOI EXECUTADO (lote dup_mesmo_cpf_20260827): os 7 pares com o MESMO
-- CPF em dois cadastros. 53 linhas movidas, nenhum duplicado ficou com
-- conteudo:
--     aluno_movimentacoes 30 | aluno_contatos 5 | confirmacoes 3
--     acordos 2 | fila_acordos 2 | estado_anterior 2 | termos 1
--     notificacoes 1 | retorno_acordo 1 | auditoria 1 | solic_financeiro 1
--     acoes_desfazer 1 | contatos repetidos removidos 3
--
-- Em 5 dos 7 o duplicado era casca vazia (sem unidade, titulo, caso ou saldo).
-- Em 2 -- Francisca Deves Serra e Andrigo do Prado Stafin -- havia conteudo dos
-- dois lados; o cadastro que ficou foi sempre o que tinha a divida.
--
-- TRES DEFEITOS que so apareceram ao rodar, e que a versao aqui ja traz
-- corrigidos (cada um abortou a transacao inteira, sem deixar meia mesclagem):
--   1. cast: aluno_id e uuid numas tabelas e text noutras;
--   2. aluno_contatos_unico: o mesmo telefone existe nos dois cadastros --
--      e a mesma pessoa. O repetido sai antes de mover;
--   3. aluno_contatos_um_principal: so um principal por tipo. O do cadastro
--      que fica prevalece.
--
-- Nao mexe em responsavel_atual_email: o guard _guard_resp_aluno barra, e com
-- razao -- trocar responsavel tem caminho proprio.

create table if not exists public._backup_mesclagem_aluno (
  id bigserial primary key,
  lote text not null,
  aluno_mantido uuid not null,
  aluno_removido uuid not null,
  tabela text not null,
  coluna text not null,
  linhas_movidas int not null,
  executado_por text,
  executado_em timestamptz not null default now()
);

create or replace function public.mesclar_aluno_duplicado(
  p_manter uuid,
  p_remover uuid,
  p_dry_run boolean default true,
  p_lote text default null
)
returns table(tabela text, coluna text, linhas int)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_cpf_manter text;
  v_cpf_remover text;
  v_n int;
  v_lote text := coalesce(p_lote, to_char(now(),'YYYYMMDDHH24MISS'));
  v_quem text := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'sistema');
begin
  if coalesce(auth.role(),'') <> 'service_role' and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: mesclar cadastro e restrito a gestao.' using errcode = '42501';
  end if;
  if p_manter is null or p_remover is null or p_manter = p_remover then
    raise exception 'Informe dois cadastros diferentes.' using errcode = '22023';
  end if;

  select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0') into v_cpf_manter
    from public.alunos where id = p_manter;
  select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0') into v_cpf_remover
    from public.alunos where id = p_remover;

  if v_cpf_manter is null or v_cpf_remover is null then
    raise exception 'Cadastro nao encontrado.' using errcode = 'P0002';
  end if;

  -- Nome igual NAO basta: so mescla quem tem o mesmo CPF.
  if v_cpf_manter <> v_cpf_remover then
    raise exception 'CPF diferente (% x %). Nome igual nao e prova de mesma pessoa -- confira no Prime antes.',
      v_cpf_manter, v_cpf_remover using errcode = '22023';
  end if;

  if not p_dry_run then
    delete from public.aluno_contatos c
     where c.aluno_id = p_remover
       and exists (select 1 from public.aluno_contatos c2
                    where c2.aluno_id = p_manter and c2.tipo = c.tipo and c2.valor = c.valor);

    update public.aluno_contatos c
       set principal = false
     where c.aluno_id = p_remover and coalesce(c.principal,false)
       and exists (select 1 from public.aluno_contatos c2
                    where c2.aluno_id = p_manter and c2.tipo = c.tipo and coalesce(c2.principal,false));
  end if;

  for r in
    select c.table_name, c.column_name, c.data_type
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
       and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name = 'aluno_id'
       and c.table_name <> 'alunos'
       and c.table_name not like '\_backup%'
       and c.table_name not like 'bkp\_%'
       and c.table_name not like '\_bkp%'
       and c.table_name not like '%backup%'
       and c.table_name not like '%\_2026____'
       and c.table_name not like '\_alvo%'
       and c.table_name not like '\_revert%'
     order by c.table_name
  loop
    if p_dry_run then
      execute format('select count(*) from public.%I where %I::text = $1', r.table_name, r.column_name)
        into v_n using p_remover::text;
    else
      execute format('update public.%I set %I = ($1)::%s where %I::text = $2',
                     r.table_name, r.column_name, r.data_type, r.column_name)
        using p_manter::text, p_remover::text;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        insert into public._backup_mesclagem_aluno
          (lote, aluno_mantido, aluno_removido, tabela, coluna, linhas_movidas, executado_por)
        values (v_lote, p_manter, p_remover, r.table_name, r.column_name, v_n, v_quem);
      end if;
    end if;

    if v_n > 0 then
      tabela := r.table_name; coluna := r.column_name; linhas := v_n;
      return next;
    end if;
  end loop;

  if not p_dry_run then
    update public.alunos
       set observacao = coalesce(nullif(btrim(observacao),'') || ' | ', '')
                        || 'CADASTRO DUPLICADO mesclado em ' || to_char(now(),'DD/MM/YYYY')
                        || ' no cadastro ' || p_manter::text || ' (lote ' || v_lote || ')',
           status_jornada = 'CADASTRO_DUPLICADO'
     where id = p_remover;
  end if;

  return;
end;
$function$;

comment on function public.mesclar_aluno_duplicado(uuid, uuid, boolean, text) is
  'Move todo o conteudo de um cadastro duplicado para o que fica e marca o duplicado (nunca apaga). Simula por padrao -- p_dry_run => false para executar. Exige mesmo CPF: nome igual nao e prova de mesma pessoa. So gestao. O que foi movido fica em _backup_mesclagem_aluno.';

revoke all on function public.mesclar_aluno_duplicado(uuid, uuid, boolean, text) from public;
grant execute on function public.mesclar_aluno_duplicado(uuid, uuid, boolean, text) to authenticated;
