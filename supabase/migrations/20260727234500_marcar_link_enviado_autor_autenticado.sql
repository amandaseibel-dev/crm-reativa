-- Hotfix: "marcar link como enviado ao aluno" falhava para o operador dono.
--
-- Sintoma (reproduzido em producao com BEGIN/ROLLBACK, como operador ativo dono
-- do atendimento):
--   ERROR: 42501: new row violates row-level security policy for table
--   "links_pagamento_historico"
--   CONTEXT: registrar_historico_link_update()
--
-- Causa: o UPDATE de status em links_pagamento dispara o trigger AFTER UPDATE
-- registrar_historico_link_update() (NAO security definer), que insere no log
-- links_pagamento_historico com usuario = coalesce(adm_responsavel,
-- operador_solicitante). Como o link ja passou pela ADM, adm_responsavel e o
-- e-mail da gestao (ex.: cobranca07/amanda), diferente do operador logado. A
-- RLS de links_pagamento_historico exige (para authenticated nao-gestao)
-- lower(usuario) = app_email(); com autor = e-mail da ADM a checagem falha e o
-- INSERT do log aborta todo o UPDATE. O operador dono nao conseguia marcar o
-- proprio link como enviado.
--
-- Correcao (minima, sem reabrir UPDATE/DELETE amplo em logs):
--   1) registrar_historico_link_update(): grava como autor o E-MAIL AUTENTICADO
--      que executou a acao (app_email()) -- que e quem de fato mudou o status.
--      Mantem fallback para adm_responsavel/operador_solicitante quando nao ha
--      JWT (roles internas / service_role, que ademais ignoram RLS). Isso
--      satisfaz a RLS existente sem afrouxa-la: o log continua exigindo autor =
--      autenticado (ou gestao).
--   2) links_pagamento_update_authenticated: remove o ramo que permitia a
--      QUALQUER usuario ativo escrever em link "sem responsavel"
--      (operador_email = ''). Passa a valer: gestao OU dono (operador_email =
--      app_email()). Terceiro e link sem responsavel ficam bloqueados para
--      operador; gestao e roles internas preservadas.
--
-- Nada de dados alterado. RLS dos logs inalterada (nao afrouxada).

-- 1) Autor do historico = quem executou (autenticado).
create or replace function public.registrar_historico_link_update()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if old.status is distinct from new.status then
    insert into public.links_pagamento_historico (
      link_id,
      status,
      usuario,
      descricao
    )
    values (
      new.id,
      new.status,
      coalesce(nullif(public.app_email(), ''), new.adm_responsavel, new.operador_solicitante),
      'Status alterado de ' || old.status || ' para ' || new.status || '.'
    );
  end if;

  return new;
end;
$function$;

-- 2) UPDATE de links_pagamento: gestao OU dono. Sem o ramo operador_email = ''.
drop policy if exists links_pagamento_update_authenticated on public.links_pagamento;
create policy links_pagamento_update_authenticated on public.links_pagamento
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email, '')) = public.app_email()
    )
  )
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email, '')) = public.app_email()
    )
  );
