import { describe, it, expect } from "vitest";
import { telasVisiveis, telasParaAdmin, CATALOGO_TELAS } from "./tvTelas";

// Snapshot mínimo que dá conteúdo a um subconjunto de slides. Slides sem a chave
// correspondente ficam SEM conteúdo (trava dura do carrossel).
function snapBase(extra = {}) {
  return {
    hoje: {},
    mes: { meta_empresa: 450000 },
    rankings: { melhor_mes: { operador: "X" } },
    dados: { ranking_semana: [{ operador: "A" }] },
    rank: { top_dia: [{ nome: "A", qtd: 3 }] },
    aniversariantes: [{ nome: "Z", dia: 10 }],
    elogios: [{ id: 1 }],
    avisos: [{ titulo: "oi", mensagem: "x" }],
    julho_historico: { ativo: false },
    metas: [],
    premiacao: { faixas: [] },
    aniversario_destaque: null,
    ...extra,
  };
}

const ids = (arr) => arr.map((t) => t.id);

describe("telasVisiveis — padrão do catálogo", () => {
  it("mostra os slides ligados de fábrica que têm conteúdo e esconde os sem conteúdo", () => {
    const vis = ids(telasVisiveis(snapBase()));
    expect(vis).toContain("hoje");
    expect(vis).toContain("magic_number");
    expect(vis).toContain("avisos");
    // metas/premiacao são ativa:false; julho está inativo no snapshot
    expect(vis).not.toContain("metas");
    expect(vis).not.toContain("premiacao");
    expect(vis).not.toContain("julho");
    // placeholders nunca entram por padrão
    expect(vis).not.toContain("hall");
  });
});

describe("telasVisiveis — override de visibilidade", () => {
  it("oculta um slide ligado de fábrica quando telas_config diz visivel:false", () => {
    const vis = ids(telasVisiveis(snapBase({ telas_config: { hoje: { visivel: false } } })));
    expect(vis).not.toContain("hoje");
    expect(vis).toContain("magic_number"); // os demais seguem normais
  });

  it("liga um slide desligado de fábrica quando há conteúdo", () => {
    const snap = snapBase({ metas: [{ id: "empresa" }], telas_config: { metas: { visivel: true } } });
    expect(ids(telasVisiveis(snap))).toContain("metas");
  });

  it("NÃO mostra um slide ligado se ele não tem conteúdo agora (trava dura)", () => {
    // metas ligado, mas snap.metas vazio => continua fora
    const snap = snapBase({ metas: [], telas_config: { metas: { visivel: true } } });
    expect(ids(telasVisiveis(snap))).not.toContain("metas");
  });
});

describe("telasVisiveis — ordem", () => {
  it("respeita telas_config.ordem (asc)", () => {
    const snap = snapBase({ telas_config: { magic_number: { ordem: 1 }, hoje: { ordem: 99 } } });
    const vis = ids(telasVisiveis(snap));
    expect(vis.indexOf("magic_number")).toBeLessThan(vis.indexOf("hoje"));
  });
});

describe("telasVisiveis — textos extras", () => {
  it("propaga subtitulo/observacao para o objeto da tela", () => {
    const snap = snapBase({ telas_config: { magic_number: { subtitulo: "Sub", observacao: "Obs" } } });
    const magic = telasVisiveis(snap).find((t) => t.id === "magic_number");
    expect(magic.extras).toEqual({ subtitulo: "Sub", observacao: "Obs" });
  });
});

describe("telasParaAdmin", () => {
  it("devolve TODOS os slides do catálogo (inclui ocultos e em construção)", () => {
    const admin = telasParaAdmin(snapBase(), {});
    expect(admin.length).toBe(CATALOGO_TELAS.length);
    expect(ids(admin)).toContain("hall"); // placeholder aparece no painel
  });

  it("reflete o override de visibilidade e o estado de conteúdo", () => {
    const admin = telasParaAdmin(snapBase(), { hoje: { visivel: false } });
    const hoje = admin.find((t) => t.id === "hoje");
    expect(hoje.visivel).toBe(false);
    expect(hoje.temConteudoAgora).toBe(true); // tem conteúdo, só está desligado

    const julho = admin.find((t) => t.id === "julho");
    expect(julho.temConteudoAgora).toBe(false);
  });

  it("marca placeholders com placeholder:true e grupo 'construcao'", () => {
    const admin = telasParaAdmin(snapBase(), {});
    const hall = admin.find((t) => t.id === "hall");
    expect(hall.placeholder).toBe(true);
    expect(hall.grupo).toBe("construcao");
  });

  it("temConteudoAgora é null quando não há snapshot", () => {
    const admin = telasParaAdmin(null, {});
    expect(admin.every((t) => t.temConteudoAgora === null)).toBe(true);
  });
});
