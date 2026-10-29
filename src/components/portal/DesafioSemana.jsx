import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { estruturaAusente } from "./curtidas";
import {
  INDICADORES, ehMensuravel, rotuloIndicador, temProgresso, percentual, cumprido,
  periodoLegivel, validarDesafio,
} from "./desafio";

export const SEM_DESAFIO = "Nenhum desafio ativo para esta semana.";

const VAZIO = {
  titulo: "", descricao: "", objetivo: "",
  indicador: "INFORMATIVO", meta: "", inicio_em: "", fim_em: "",
};

// Desafio coletivo vigente. O progresso vem contado do dado real pela RPC
// portal_desafio_vigente -- esta tela nao soma nada e nao aceita numero digitado.
//
// `podeGerir` apenas mostra ou esconde o formulario. Quem decide de verdade e a
// policy portal_desafios_gestao no banco: um operador que forjasse a chamada
// levaria 42501.
export default function DesafioSemana({ usuario, podeGerir, Card, CabecalhoCard, S }) {
  const [desafio, setDesafio] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [disponivel, setDisponivel] = useState(true);
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState(VAZIO);
  const [salvando, setSalvando] = useState(false);

  const buscar = useCallback(() => supabase.rpc("portal_desafio_vigente"), []);

  const aplicar = useCallback(({ data, error }) => {
    setCarregando(false);
    if (error) {
      if (estruturaAusente(error)) { setDisponivel(false); return; }
      console.error("portal_desafio_vigente:", error);
      setDesafio(null);
      return;
    }
    setDisponivel(true);
    setDesafio(Array.isArray(data) ? (data[0] ?? null) : (data ?? null));
  }, []);

  useEffect(() => {
    let vivo = true;
    buscar().then((res) => { if (vivo) aplicar(res); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  const recarregar = useCallback(async () => { aplicar(await buscar()); }, [buscar, aplicar]);

  async function salvar(e) {
    e.preventDefault();
    const problema = validarDesafio(form);
    if (problema) { alert(problema); return; }

    setSalvando(true);
    const { error } = await supabase.from("portal_desafios").insert({
      titulo: form.titulo.trim(),
      descricao: form.descricao.trim() || null,
      objetivo: form.objetivo.trim() || null,
      indicador: form.indicador,
      meta: ehMensuravel(form.indicador) ? Number(form.meta) : null,
      inicio_em: form.inicio_em,
      fim_em: form.fim_em,
      criado_por_email: usuario?.email || null,
    });
    setSalvando(false);

    if (error) {
      console.error("Erro ao salvar desafio:", error);
      if (error.code === "42501") alert("Somente a gestão pode cadastrar desafio.");
      else if (error.code === "23514") alert("Indicador, meta e período precisam ser coerentes.");
      else alert(`Não foi possível salvar o desafio. Código: ${error.code || "sem código"}.`);
      return;
    }
    setForm(VAZIO);
    setAberto(false);
    recarregar();
  }

  if (!disponivel) return null;

  const pct = percentual(desafio);

  return (
    <Card>
      <CabecalhoCard
        icone="🎯"
        titulo="Desafio da semana"
        acao={podeGerir ? (
          <button type="button" onClick={() => setAberto((v) => !v)} style={S.botaoMini}>
            {aberto ? "Fechar" : "+ Desafio"}
          </button>
        ) : null}
      />

      {aberto && podeGerir && (
        <form onSubmit={salvar} style={S.form}>
          <input value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Título do desafio" style={S.input} />
          <input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} placeholder="Descrição (opcional)" style={S.input} />
          <input value={form.objetivo} onChange={(e) => setForm({ ...form, objetivo: e.target.value })} placeholder="Objetivo (opcional)" style={S.input} />
          <select
            value={form.indicador}
            onChange={(e) => setForm({ ...form, indicador: e.target.value, meta: ehMensuravel(e.target.value) ? form.meta : "" })}
            style={S.input}
            aria-label="Indicador"
          >
            {INDICADORES.map((i) => <option key={i.valor} value={i.valor}>{i.rotulo}</option>)}
          </select>
          {ehMensuravel(form.indicador) && (
            <input type="number" min="1" value={form.meta} onChange={(e) => setForm({ ...form, meta: e.target.value })} placeholder="Meta (ex.: 20)" style={S.input} />
          )}
          <div style={S.formLinha}>
            <input type="date" value={form.inicio_em} onChange={(e) => setForm({ ...form, inicio_em: e.target.value })} style={S.input} aria-label="Início" />
            <input type="date" value={form.fim_em} onChange={(e) => setForm({ ...form, fim_em: e.target.value })} style={S.input} aria-label="Fim" />
          </div>
          <button disabled={salvando} style={S.botaoPrimario}>{salvando ? "Salvando..." : "Salvar desafio"}</button>
        </form>
      )}

      {desafio ? (
        <div style={S.desafio}>
          <strong style={S.desafioTitulo}>{desafio.titulo}</strong>
          {desafio.descricao && <p style={S.desafioTexto}>{desafio.descricao}</p>}
          {desafio.objetivo && <p style={S.desafioObjetivo}>🎯 {desafio.objetivo}</p>}

          {temProgresso(desafio) ? (
            <div style={S.desafioMedida}>
              <div style={S.desafioNumeros}>
                <strong style={S.desafioProgresso}>{desafio.progresso} / {desafio.meta}</strong>
                <span style={S.mutedPequeno}>{rotuloIndicador(desafio.indicador)}</span>
              </div>
              <div style={S.barra} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ ...S.barraCheia, width: `${pct}%`, ...(cumprido(desafio) ? S.barraCumprida : null) }} />
              </div>
              {cumprido(desafio) && <span style={S.desafioCumprido}>Meta alcançada 🎉</span>}
            </div>
          ) : (
            <p style={S.mutedPequeno}>Desafio informativo, sem medição automática.</p>
          )}

          <span style={S.desafioPeriodo}>Período: {periodoLegivel(desafio.inicio_em, desafio.fim_em)}</span>
        </div>
      ) : (
        <p style={S.muted}>{carregando ? "Buscando o desafio da semana..." : SEM_DESAFIO}</p>
      )}
    </Card>
  );
}
